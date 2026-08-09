// The `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost`: the shell-side facts no registry
// holds — a database to query, a migrator, a test runner, the dev log, the committed manifest and
// the gate. The description half is the framework's own `frameworkIntrospection`, so nothing here
// is a second catalog of routes, entities, actions, queries or jobs.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agentActor, describeErrorCode, hasErrorCode, UltimateError } from '@ultimat3/core';
import { pgliteDataDir, raw, readLedger } from '@ultimat3/db';
import { inspectJobList, inspectQueues } from '@ultimat3/jobs';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import type {
  DatabaseTarget,
  DevCapabilities,
  ErrorExplanation,
  McpCaller,
  McpServer,
  QueryResult,
  TestRun,
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
import { MIGRATIONS_DIR } from './drift';
import type { CliErrorCode } from './errors';
import { CLI_ERROR_CODES, CliNotImplementedError, docsFor } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';

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

// ── the database this host is pointed at ─────────────────────────────────────

/**
 * `production` is always false: this target is whatever `x dev` resolved — embedded PGlite under
 * `.x/`, or the `DATABASE_URL` of a developer's shell. Production is reached through `ROLE=migrate`
 * in a deploy hook, never through MCP. What actually stops a migration against a shared database is
 * `branch`, which is null unless the name says otherwise.
 */
export function databaseTarget(services: DevServices): DatabaseTarget {
  const url = services.db.url;
  return services.db.mode === 'embedded'
    ? { label: url, branch: pgliteBranch(url, services.stateDir), production: false }
    : { label: safeLabel(url), branch: postgresBranch(url), production: false };
}

/** An external `DATABASE_URL` may carry credentials, and this string gets printed. */
function safeLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'external database';
  }
}

/** `x db branch <name>` names an external clone `<source>_branch_<name>` (`branchDatabaseName`). */
function postgresBranch(url: string): string | null {
  let database: string;
  try {
    database = new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
  return /_branch_(.+)$/.exec(database)?.[1] ?? null;
}

/** `branchPglite` copies `<stateDir>/pgdata` to `<stateDir>/pgdata-<name>`; the dev dir is no branch. */
function pgliteBranch(url: string, stateDir: string): string | null {
  const dir = pgliteDataDir(url);
  const dev = join(stateDir, 'pgdata');
  if (dir === dev || basename(dir) === basename(dev)) return null;
  return dir.startsWith(`${dev}-`) ? dir.slice(dev.length + 1) : null;
}

// ── errors.explain ───────────────────────────────────────────────────────────

/** One runnable command per CLI code. Typed over `CliErrorCode`, so a new code fails the build. */
const CLI_FIXES: Readonly<Record<CliErrorCode, string>> = {
  X_CLI_UNKNOWN_COMMAND: 'x help',
  X_CLI_BAD_FLAG: 'x help <command>',
  X_VERIFY_FAILED: 'x verify --json',
  X_NOT_IN_APP: 'x new myapp && cd myapp',
  X_BUN_VERSION: 'bun upgrade',
  X_NOT_IMPLEMENTED: 'x doctor --json',
  X_TEST_NO_FILES: 'x test --cwd <repo root>',
  X_TEST_SHARD_FAILED: 'x test --workers 1',
  X_SCAFFOLD_PATH_ESCAPE: 'x g route <name>   # a path with no ".." segment',
};

const isCliCode = (code: string): code is CliErrorCode =>
  (CLI_ERROR_CODES as readonly string[]).includes(code);

/**
 * `undefined` for a code nobody registered — the tool then answers "unknown error code", which
 * beats an invented explanation. The framework-wide registry holds a title and a docs URL but no
 * fix (a thrown error carries its own), so a non-CLI code points at the gate that surfaces it.
 */
export function explainErrorCode(code: string): ErrorExplanation | undefined {
  const cli = isCliCode(code);
  if (!cli && !hasErrorCode(code)) return undefined;
  const described = describeErrorCode(code);
  return {
    code,
    cause: described.title,
    fix: cli ? CLI_FIXES[code] : 'x verify --json',
    docs: cli ? docsFor(code) : described.docs,
  };
}

// ── tests.run ────────────────────────────────────────────────────────────────

const TAIL_LINES = 20;
const FAIL_LINE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;
const ERROR_LINE = /^\s*error:\s*(.+)$/;

const lastCount = (output: string, label: string): number | undefined => {
  const last = [...output.matchAll(new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, 'gm'))].at(-1);
  return last === undefined ? undefined : Number.parseInt(last[1] ?? '0', 10);
};

const tailOf = (output: string): string => {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  return lines.length === 0 ? 'bun test produced no output' : lines.slice(-TAIL_LINES).join('\n');
};

/**
 * Bun prints its own summary, so this reads it instead of counting anything a second time. Output
 * it cannot recognise is reported as a FAILED run carrying the raw tail: returning zeros there
 * would turn a runner that crashed before it started into a green run.
 */
export function parseBunTest(output: string, durationMs: number): TestRun {
  const passed = lastCount(output, 'pass');
  const failed = lastCount(output, 'fail');
  if (passed === undefined && failed === undefined) {
    const failure = { test: 'bun test', message: tailOf(output) };
    return { passed: 0, failed: 1, skipped: 0, durationMs, failures: [failure] };
  }
  const failures: { test: string; message: string }[] = [];
  let message = '';
  for (const line of output.split('\n')) {
    const error = ERROR_LINE.exec(line);
    if (error !== null) {
      message = error[1] ?? '';
      continue;
    }
    const fail = FAIL_LINE.exec(line.trimEnd());
    if (fail === null) continue;
    failures.push({
      test: (fail[1] ?? '').trim(),
      message: message === '' ? 'no error message in the run output' : message,
    });
    message = '';
  }
  return {
    passed: passed ?? 0,
    failed: failed ?? 0,
    // `skip` and `todo` print on separate lines and both mean "not run".
    skipped: (lastCount(output, 'skip') ?? 0) + (lastCount(output, 'todo') ?? 0),
    durationMs,
    failures,
  };
}

// ── the lazily booted services ───────────────────────────────────────────────

interface LazyServices {
  readonly services: DevServices;
  running(): Promise<RunningServices>;
  close(): Promise<void>;
}

/**
 * The database boots on FIRST USE, once, and is shared: answering `routes.list` must not pay a
 * PGlite boot. Same resolver and same drivers as `x dev` — a dev-only second driver is exactly the
 * bug that design exists to prevent.
 */
function lazyServices(input: DevHostInput): LazyServices {
  const services = resolveServices(input.root, input.env);
  let started: Promise<RunningServices> | undefined;
  let closed = false;
  return {
    services,
    running(): Promise<RunningServices> {
      started ??= startServices(services);
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

/** Migration ids on disk (`0001_init.sql` → `0001_init`) that the ledger does not record. */
async function pendingMigrations(root: string, lazy: LazyServices): Promise<readonly string[]> {
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for await (const file of new Bun.Glob('*.sql').scan({ cwd: dir, absolute: false })) {
    if (!file.endsWith('.down.sql')) ids.push(file.replace(/\.sql$/, ''));
  }
  const { db } = await lazy.running();
  // No ledger table means nothing has been applied. `ensureLedger` would create it, and a dry run
  // is not allowed to write.
  const ledger = await readLedger(db).catch(() => []);
  const applied = new Set(ledger.map((row) => row.id));
  return ids.filter((id) => !applied.has(id)).sort();
}

// ── the capabilities ─────────────────────────────────────────────────────────

function capabilities(input: DevHostInput, lazy: LazyServices): DevCapabilities {
  const { root, runner } = input;
  return {
    database: databaseTarget(lazy.services),

    // `assertReadOnlyQuery` already refused writes, batches and locking clauses inside the tool,
    // before this host was reached; a second gate here would be a second place to keep right.
    // The cap is applied in memory rather than by appending a LIMIT, which would change the
    // meaning of a statement that carries its own.
    async runQuery(sql: string, limit: number): Promise<QueryResult> {
      const { db } = await lazy.running();
      const rows = await db.query<Record<string, unknown>>(raw(sql));
      const columns = Object.keys(rows[0] ?? {});
      const capped = rows.slice(0, limit);
      return {
        columns,
        rows: capped.map((row) => columns.map((column) => row[column])),
        // Counts what came back; `truncated` is how the caller learns there was more.
        rowCount: capped.length,
        truncated: rows.length > limit,
      };
    },

    async runMigrations(branch: string, dryRun: boolean) {
      const before = await pendingMigrations(root, lazy);
      if (dryRun) return { branch, applied: [], pending: before };
      const result = await runner(['bunx', 'drizzle-kit', 'migrate'], { cwd: root });
      if (!result.ok) {
        // Thrown, not returned: `server.ts` renders any X_* error as the three-line
        // code/cause/fix result, which is what an agent needs to act without a round trip.
        throw new UltimateError({
          code: 'X_DB_MIGRATE_FAILED',
          cause: `${result.command.join(' ')} exited ${result.code}: ${execOutput(result).slice(0, 400)}`,
          fix: 'x db reset',
        });
      }
      // The ledger is the evidence for "applied" — never the migrator's own stdout.
      const pending = await pendingMigrations(root, lazy);
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
  await loadApp(input.root);
  const lazy = lazyServices(input);
  const introspection = frameworkIntrospection({
    routes: () => describeRoutes(),
    policies: () => policyFacts(),
  });
  const server = createDevServer({ host: devHost(introspection, capabilities(input, lazy)) });
  const caller = localCaller();
  return { server, caller, tools: server.tools.names(caller), close: () => lazy.close() };
}
