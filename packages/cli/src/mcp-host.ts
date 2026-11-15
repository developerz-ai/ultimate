// The `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost`: the shell-side facts no registry
// holds — a database to query, a migrator, a test runner, the dev log, the committed manifest and
// the gate. The description half is the framework's own `frameworkIntrospection`, so nothing here
// is a second catalog of routes, entities, actions, queries or jobs.

// why: Bun exposes no path API. Every use here builds a path this host then hands to `Bun.file`
// or prints inside a `fix:` an operator runs — the dev log, a per-role log, the committed
// manifest — and string concatenation would answer a different path on a Windows checkout.
import { join } from 'node:path';
import {
  agentActor,
  isUltimateError,
  renderThrowable,
  retryMemo,
  UltimateError,
} from '@ultimat3/core';
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
import { impactOf, MANIFEST_FILENAME, pathBetween } from '@ultimat3/manifest';
import type {
  DevCapabilities,
  DevGraphQuestion,
  McpCaller,
  McpServer,
  QueryLimits,
  QueryRows,
  VerifyResult,
} from '@ultimat3/mcp';
import { DEV_SCOPES, devHost, devMcpServer, frameworkIntrospection } from '@ultimat3/mcp';
import { loadApp } from './app-load';
import { appManifest, policyFacts } from './app-manifest';
import { loadAppRuntime } from './app-runtime';
import { loadAppGraph, resolveNode } from './cmd-graph-load';
import { declareDevEnvironment, needsDevEnvironmentDeclaration } from './dev-environment';
import { liveDevLock } from './dev-lock';
import { loadCodeFixes } from './error-fixes';
import type { Runner } from './exec';
import { assertExplainTarget, devNotRunning, narrowVerify, searchDocs } from './mcp-agent-host';
import { databaseTarget } from './mcp-db-target';
import { explainErrorCode } from './mcp-errors';
import { readLogTail } from './mcp-host-logs';
import { type ShellRunInput, shellRunner, shellTests, shellVerify } from './mcp-host-shell';
import { requestStatements } from './mcp-request-statements';
import { type UiCapabilities, uiCapabilities } from './mcp-ui';
import { readMigrations } from './migrations';
import { plainAppRoutes, routeRows } from './route-table';
import type { DevServices, Env } from './runtime-bindings';
import { resolveServices } from './runtime-bindings';
import type { RunningServices } from './runtime-services';
import { startServices } from './runtime-services';

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
  // `retryMemo`, not `??=`: a boot that REJECTED is not an answer to keep. A Postgres that refused
  // one connection wedged every later tool call in the session with that first error, and the only
  // way out was restarting the host — `startServices` unwinds everything it started before it
  // rejects, so there is nothing left over for a second attempt to collide with.
  // `[]`: this host starts no role, so it only ever publishes to the bus and never waits for it.
  // The app's `runtime.ts`, read per attempt as `x dev` reads it: its ports, its clock, its key.
  const boot = retryMemo(async () =>
    startServices(services, input.env, await loadAppRuntime(input.root), 'apply', []),
  );
  let closed = false;
  return {
    services,
    running(): Promise<RunningServices> {
      // A boot started after close() would hold the PGlite data directory for the life of the
      // process with nobody left to stop it — the host is closed, so the call is the bug.
      if (closed) {
        // Core's code for work that arrives after shutdown: nothing is missing from this build.
        throw new UltimateError({
          code: 'X_DRAINING',
          cause:
            'an MCP tool needed the database after this host closed, and a closed host is not reopened',
          fix: 'x mcp serve --transport stdio   # a new session: a closed host is replaced, never reused',
          retry: 'terminal',
        });
      }
      return boot.get();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // `started()` and never `get()`: closing must not BOOT a database in order to stop one. A
      // boot that rejected has nothing to stop, and close() must not throw on the way out.
      await (await boot.started()?.catch(() => undefined))?.stop();
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

/**
 * `db.migrate`'s answer to a foreign throw. The fix is the REGISTERED one (`mcp-errors.ts`), never
 * a literal here: this said `x db reset`, and an agent that followed it wiped the database the
 * migration had failed against.
 */
export function migrateFailed(error: unknown): UltimateError {
  return new UltimateError({
    code: 'X_DB_MIGRATE_FAILED',
    // The blessed total renderer: `String(error)` runs the value's own `toString`, and this is
    // the last hop before an agent is handed the three-line result.
    cause: renderThrowable(error),
    fix:
      explainErrorCode('X_DB_MIGRATE_FAILED')?.fix ?? 'x errors explain X_DB_MIGRATE_FAILED --json',
  });
}

// `logs.tail`'s reader lives in `mcp-host-logs.ts`; re-exported for `x logs tail` and the tests.
export { lineRole, logTailPath, type TailSource, tailLines } from './mcp-host-logs';

function capabilities(
  input: DevHostInput,
  lazy: LazyServices,
  ui: UiCapabilities,
  declared: boolean,
): DevCapabilities {
  const { root } = input;
  const shell: ShellRunInput = { ...input, declared };
  // Layer 1 is seven idempotent DDL statements, and `db.query` is a tool an agent calls in a
  // loop — resolve the role once per process and reuse the answer, `null` included. A FAILED
  // resolution is not an answer: `??=` kept the rejection, so a statement timeout on the DDL
  // meant every later `db.query` in the session refused with it instead of trying again.
  //
  // It asks `lazy.running()` for the client rather than closing over one: this runs before any
  // boot has happened, and the boot is memoised, so it is the same connection `runQuery` uses.
  const readOnlyRole = retryMemo(async () => ensureReadOnlyRole((await lazy.running()).db));

  return {
    database: databaseTarget(lazy.services, input.env),

    async runQuery(sql: string, limits: QueryLimits): Promise<QueryRows> {
      const { db } = await lazy.running();
      // A managed Postgres may refuse CREATE ROLE; `ensureReadOnlyRole` answers null and the
      // layer is reported absent in `guards` rather than quietly assumed present.
      return readOnlyRows(db, sql, limits, await readOnlyRole.get());
    },

    // `db.query`'s layers 1–2 again, behind `x explain`'s production refusal: with `analyze` the
    // plan is executed, so a production database is refused before any connection is opened.
    async explainQuery(statement: string, limits: QueryLimits): Promise<QueryRows> {
      assertExplainTarget(lazy.services, input.env);
      const { db } = await lazy.running();
      return readOnlyRows(db, statement, limits, await readOnlyRole.get());
    },

    searchDocs: (query: string, limit: number) => searchDocs(input, query, limit),

    async requestStatements(ask) {
      // The lock `x dev` writes names its URL; a missing or stale one is no server to ask.
      const lock = liveDevLock(lazy.services.stateDir);
      if (lock === undefined) throw devNotRunning();
      return requestStatements({ devUrl: lock.url, ...ask });
    },

    narrowVerify: (file: string) => narrowVerify(root, file),

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
        throw migrateFailed(error);
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

    // `x test` itself, never a second test path: the files, batches and env the shell gets.
    runTests: (filter: string | undefined) => shellTests(shell, filter),

    // A role's own log when one was written, else its lines of the dev log (`mcp-host-logs.ts`).
    tailLogs: async (lines: number, role: string | undefined) =>
      (await readLogTail(lazy.services.stateDir, lines, role)).lines,

    async readManifest() {
      const file = Bun.file(join(root, MANIFEST_FILENAME));
      // The contract is "the generated manifest as text", so an app that has never run
      // `x manifest` gets the current one rather than a failure.
      if (await file.exists()) return file.text();
      return JSON.stringify((await appManifest(root)).manifest, null, 2);
    },

    explainError: explainErrorCode,

    // Loaded per question, as `x impact` loads it: an agent asks between edits, and a graph held
    // for the session would answer for the code as it was when the host started.
    async queryGraph(question: DevGraphQuestion) {
      const { graph } = await loadAppGraph(root);
      if (question.kind === 'impact') return impactOf(graph, resolveNode(graph, question.node));
      return pathBetween(graph, resolveNode(graph, question.from), resolveNode(graph, question.to));
    },

    ...ui,

    async verify(fix: boolean, only?: readonly string[]): Promise<VerifyResult> {
      // The one safe autofix this repo actually has. Anything more would be the gate rewriting
      // code it was asked to judge.
      if (fix) await shellRunner(shell)(['bunx', 'biome', 'check', '--write', '.'], { cwd: root });
      return shellVerify(shell, only);
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
  // BEFORE `loadApp` imports a single app module, for the reason `x dev` and `startDev` declare
  // it first: a scaffolded app's dev actor installs itself at import time, and installs nothing
  // into a process that has not said it is development. Measured on 20.1.5: the first `ui.shot`
  // in a session photographed a 401 (`actorKind: anonymous`), and only the second call — whose
  // scratch boot re-imported the app after declaring — rendered. Idempotent; a set key stays.
  // Asked before declaring: whether the key is this process's own is what `tests.run` and
  // `verify.run` strip from their children, so they run as the shell runs them.
  const declared = needsDevEnvironmentDeclaration(input.env);
  declareDevEnvironment(input.env);
  await Promise.all([loadApp(input.root), loadCodeFixes()]);
  // The plain `runtime.ts` routes, read once: `routes.list` answers the table `x routes` prints.
  const plain = await plainAppRoutes(input.root);
  const lazy = lazyServices(input);
  const ui = uiCapabilities({ root: input.root, env: input.env });
  const introspection = frameworkIntrospection({
    routes: () => routeRows(plain).map((row) => row.json),
    policies: () => policyFacts(),
  });
  const server = devMcpServer({
    host: devHost(introspection, capabilities(input, lazy, ui, declared)),
  });
  const caller = localCaller();
  return {
    server,
    caller,
    tools: server.tools.names(caller),
    // The scratch server first: it holds the same embedded database the lazy services would.
    close: async () => {
      await ui.close();
      await lazy.close();
    },
  };
}
