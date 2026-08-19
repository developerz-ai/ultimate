// The `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost`: the shell-side facts no registry
// holds — a database to query, a migrator, a test runner, the dev log, the committed manifest and
// the gate. The description half is the framework's own `frameworkIntrospection`, so nothing here
// is a second catalog of routes, entities, actions, queries or jobs.

import { join } from 'node:path';
import { agentActor, isUltimateError, renderThrowable, UltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import {
  ensureReadOnlyRole,
  isLedgerMissing,
  migrate,
  pendingMigrations,
  readLedger,
  readOnlyQuery,
} from '@ultimat3/db';
import { inspectJobList, inspectQueues } from '@ultimat3/jobs';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import type {
  DevCapabilities,
  McpCaller,
  McpServer,
  QueryLimits,
  QueryRows,
  VerifyResult,
  VerifyStep,
} from '@ultimat3/mcp';
import { createDevServer, DEV_SCOPES, devHost, frameworkIntrospection } from '@ultimat3/mcp';
import { describeRoutes } from '@ultimat3/render';
import { loadApp } from './app-load';
import { appManifest, policyFacts } from './app-manifest';
import { runVerify, VERIFY_STEPS } from './cmd-verify';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import type { DevServices, Env } from './dev-services';
import { resolveServices } from './dev-services';
import { loadCodeFixes } from './error-fixes';
import { CliNotImplementedError } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { databaseTarget } from './mcp-db-target';
import { explainErrorCode } from './mcp-errors';
import { parseBunTest } from './mcp-test-output';
import { readMigrations } from './migrations';

export interface DevHostInput {
  readonly root: string;
  readonly env: Env;
  readonly runner: Runner;
}

export interface CliMcpServer {
  readonly server: McpServer;
  readonly caller: McpCaller;
  /** Tool names this caller can see, sorted. The catalog `x mcp tools` prints. */
  readonly tools: readonly string[];
  close(): Promise<void>;
}

/** Every dev scope. Both transports resolve to this set — one surface, one entitlement. */
export const DEV_TOOL_SCOPES: ReadonlySet<string> = new Set(Object.values(DEV_SCOPES));

/**
 * The developer's own shell. A stdio peer already owns the process, so there is no network
 * boundary to defend and the caller carries every dev scope. `kind: 'agent'` because
 * `transport-http.ts` structurally refuses anything else and both transports must resolve to the
 * same caller — an MCP call is an agent call, never the human behind it.
 */
export function localCaller(): McpCaller {
  return {
    actor: agentActor({ id: 'x-cli', scopes: [...DEV_TOOL_SCOPES] }),
    scopes: DEV_TOOL_SCOPES,
  };
}

// ── the lazily booted services ───────────────────────────────────────────────

export interface LazyServices {
  readonly services: DevServices;
  running(): Promise<RunningServices>;
  close(): Promise<void>;
}

/**
 * The database boots on FIRST USE, once, and is shared: answering `routes.list` must not pay a
 * PGlite boot. Same resolver and same drivers as `x dev` — a dev-only second driver is exactly the
 * bug that design exists to prevent. Exported as the boot seam a test can drive without a server.
 */
export function lazyServices(input: DevHostInput): LazyServices {
  const services = resolveServices(input.root, input.env);
  let started: Promise<RunningServices> | undefined;
  let closed = false;
  return {
    services,
    running(): Promise<RunningServices> {
      // A boot started after close() would hold the PGlite data directory for the life of the
      // process with nobody left to stop it — the host is closed, so the call is the bug.
      if (closed) {
        throw new CliNotImplementedError({
          feature: 'an MCP tool that needs the database after the host closed',
          fix: 'x mcp serve --transport stdio   # keep the host open for the whole session',
        });
      }
      started ??= startServices(services, input.env);
      return started;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // A boot that rejected has nothing to stop, and close() must not throw on the way out.
      await (await started?.catch(() => undefined))?.stop();
    },
  };
}

/**
 * Migration ids on disk that the ledger does not record. Both halves are the framework's own —
 * `readMigrations` is the list `ROLE=migrate` applies and `pendingMigrations` is the filter
 * `migrate()` applies it through, so this tool can never report a pending set the migrator would
 * disagree with.
 */
async function pendingIds(root: string, lazy: LazyServices): Promise<readonly string[]> {
  const migrations = await readMigrations(root);
  if (migrations.length === 0) return [];
  const { db } = await lazy.running();
  // No ledger table means nothing has been applied. `ensureLedger` would create it, and a dry run
  // is not allowed to write. Only that condition: a permission denied or an unreachable server is
  // a ledger nobody read, and answering it with `[]` reports every migration as pending against a
  // database whose state this tool never saw.
  const ledger = await readLedger(db).catch((error: unknown) => {
    if (!isLedgerMissing(error)) throw error;
    return [];
  });
  return pendingMigrations(ledger, migrations).map((migration) => migration.id);
}

// ── the capabilities ─────────────────────────────────────────────────────────

/**
 * `db.query`'s layers 1–2 against a real client: a SELECT-only role assumed inside a
 * `BEGIN READ ONLY` transaction with a statement timeout, then the rows shaped into the tool's
 * column-major form. Layer 3 (`assertReadOnlyQuery`) and layer 4 (the caps) run in the tool,
 * before and after this — a second copy here would be a second place to keep right.
 *
 * Exported as the seam a test drives with a recording client, so the statement sequence is
 * asserted without booting a database.
 */
export async function readOnlyRows(
  db: DbClient,
  sql: string,
  limits: QueryLimits,
  role: string | null,
): Promise<QueryRows> {
  const { rows, guards } = await readOnlyQuery<Record<string, unknown>>(sql, {
    client: db,
    role,
    timeoutMs: limits.timeoutMs,
    // One row past the ceiling: the tool needs to know there was more. Asked of the *server*,
    // through the cursor the pinned read-only transaction already makes available, so a
    // `select * from events` cannot be paged into this process before layer 4 gets to drop it.
    // Wrapping the statement in `select * from (…) limit n` instead would change the meaning of
    // a statement carrying its own LIMIT and fail outright on `EXPLAIN` and `SHOW`.
    maxRows: limits.maxRows + 1,
  });
  const columns = Object.keys(rows[0] ?? {});
  // `EXPLAIN` and `SHOW` are commands, not cursorable, so they arrive whole — the slice is the
  // only bound they have.
  const kept = rows.slice(0, limits.maxRows + 1);
  return { columns, rows: kept.map((row) => columns.map((column) => row[column])), guards };
}

function capabilities(input: DevHostInput, lazy: LazyServices): DevCapabilities {
  const { root, runner } = input;
  // Layer 1 is seven idempotent DDL statements, and `db.query` is a tool an agent calls in a
  // loop — resolve the role once per process and reuse the answer, `null` included.
  let readOnlyRole: Promise<string | null> | undefined;

  return {
    database: databaseTarget(lazy.services, input.env),

    async runQuery(sql: string, limits: QueryLimits): Promise<QueryRows> {
      const { db } = await lazy.running();
      // A managed Postgres may refuse CREATE ROLE; `ensureReadOnlyRole` answers null and the
      // layer is reported absent in `guards` rather than quietly assumed present.
      readOnlyRole ??= ensureReadOnlyRole(db);
      return readOnlyRows(db, sql, limits, await readOnlyRole);
    },

    async runMigrations(branch: string, dryRun: boolean) {
      const before = await pendingIds(root, lazy);
      if (dryRun) return { branch, applied: [], pending: before };
      const { db } = await lazy.running();
      try {
        await migrate({ migrations: await readMigrations(root), client: db });
      } catch (error) {
        // Thrown, not returned: `server.ts` renders any X_* error as the three-line
        // code/cause/fix result, which is what an agent needs to act without a round trip. The
        // engine's own errors already carry that shape and pass through untouched.
        if (isUltimateError(error)) throw error;
        throw new UltimateError({
          code: 'X_DB_MIGRATE_FAILED',
          // The blessed total renderer: `String(error)` runs the value's own `toString`, and
          // this is the last hop before an agent is handed the three-line result.
          cause: renderThrowable(error),
          fix: 'x db reset',
        });
      }
      // The ledger is the evidence for "applied" — never the migrator's own return value.
      const pending = await pendingIds(root, lazy);
      return { branch, applied: before.filter((id) => !pending.includes(id)), pending };
    },

    async queueDepth() {
      const { jobs } = await lazy.running();
      const report = await inspectQueues(jobs);
      // `stats()` counts states, and a job is `failed` only until it is retried or dead-lettered;
      // the honest count comes from the job list. Same reading as /_x's queues panel.
      const failed =
        jobs.introspect === undefined ? [] : await inspectJobList(jobs, { state: 'failed' });
      return report.queues.map((queue) => ({
        queue: queue.queue,
        pending: queue.ready + queue.delayed,
        running: queue.running,
        failed: failed.filter((record) => record.queue === queue.queue).length,
      }));
    },

    // `bun test <filter>` matches on the test path, the same rule `x test`'s `discoverTests` uses.
    async runTests(filter: string | undefined) {
      const result = await runner(
        filter === undefined ? ['bun', 'test'] : ['bun', 'test', filter],
        {
          cwd: root,
        },
      );
      return parseBunTest(execOutput(result), result.durationMs);
    },

    async tailLogs(lines: number, role: string | undefined) {
      const dir = lazy.services.stateDir;
      const path = role === undefined ? join(dir, 'dev.log') : join(dir, 'logs', `${role}.log`);
      const file = Bun.file(path);
      if (!(await file.exists())) {
        // `@ultimat3/core`'s `logger` is a module const with no sink seam, so there is nothing to
        // intercept in-process — a log on disk is the only honest source, and the fix creates one.
        throw new CliNotImplementedError({
          feature: `logs.tail without ${path}`,
          fix:
            role === undefined
              ? `x dev > ${path} 2>&1`
              : `mkdir -p ${join(dir, 'logs')} && x dev --role ${role} > ${path} 2>&1`,
        });
      }
      return (await file.text()).trimEnd().split('\n').slice(-lines);
    },

    async readManifest() {
      const file = Bun.file(join(root, MANIFEST_FILENAME));
      // The contract is "the generated manifest as text", so an app that has never run
      // `x manifest` gets the current one rather than a failure.
      if (await file.exists()) return file.text();
      return JSON.stringify((await appManifest(root)).manifest, null, 2);
    },

    explainError: explainErrorCode,

    async verify(fix: boolean): Promise<VerifyResult> {
      // The one safe autofix this repo actually has. Anything more would be the gate rewriting
      // code it was asked to judge.
      if (fix) await runner(['bunx', 'biome', 'check', '--write', '.'], { cwd: root });
      const result = await runVerify(VERIFY_STEPS, { root, runner });
      return {
        ok: result.ok,
        steps: (result.steps ?? []).map((step): VerifyStep => {
          const detail = step.findings[0]?.cause;
          // exactOptionalPropertyTypes: omit `detail`, never hand over an explicit undefined.
          return detail === undefined
            ? { name: step.name, ok: step.ok }
            : { name: step.name, ok: step.ok, detail };
        }),
      };
    },
  };
}

/**
 * Loading the app IS the registration, so it happens before the server is built: every
 * introspection tool then answers from the framework's own registries, not from a scan.
 */
export async function createDevMcpServer(input: DevHostInput): Promise<CliMcpServer> {
  // `explainError` is synchronous by `DevCapabilities`' own signature, so the walk that reads the
  // framework's `fix:` lines happens here, once, or `errors.explain` answers with the fallback for
  // every code it could have quoted.
  await Promise.all([loadApp(input.root), loadCodeFixes()]);
  const lazy = lazyServices(input);
  const introspection = frameworkIntrospection({
    routes: () => describeRoutes(),
    policies: () => policyFacts(),
  });
  const server = createDevServer({ host: devHost(introspection, capabilities(input, lazy)) });
  const caller = localCaller();
  return { server, caller, tools: server.tools.names(caller), close: () => lazy.close() };
}
