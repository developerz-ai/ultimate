// The built-in MCP dev server — the reason an agent needs no framework documentation.
//
// Documentation describes; these tools answer. An agent asks `routes.list` instead of
// reading a routing guide, `errors.explain` instead of searching a code, `verify.run`
// instead of guessing whether it is done. Every tool declares a scope, and the two that can
// change something (`db.migrate`, `tests.run`) say so in their own description so a model
// reading only the catalog still knows what it is holding.
//
// Data sources are a single injected `DevHost`. Route and policy description live in
// packages of this same tier, and the shell-side capabilities (db, tests, logs) belong to
// the CLI, so this file defines the interface and the CLI satisfies it.

import type { DatabaseTarget } from './readonly-sql.ts';
import { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql.ts';
import type { AnyMcpTool, McpToolResult, ToolArgs } from './registry.ts';
import { jsonResult, textResult } from './registry.ts';
import type { JsonSchema } from './wire.ts';
import { NO_ARGS } from './wire.ts';

/** Scopes the dev server gates on. A token carries a subset; the rest is invisible. */
export const DEV_SCOPES = {
  read: 'dev:read',
  test: 'dev:test',
  logs: 'dev:logs',
  dbRead: 'db:read',
  dbMigrate: 'db:migrate',
} as const;

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface TestRun {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
  readonly failures: readonly { readonly test: string; readonly message: string }[];
}

export interface MigrateResult {
  readonly branch: string;
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export interface QueueDepth {
  readonly queue: string;
  readonly pending: number;
  readonly running: number;
  readonly failed: number;
}

export interface ErrorExplanation {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
}

export interface VerifyStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly steps: readonly VerifyStep[];
}

/** Description sources. Satisfied by `frameworkIntrospection` in a real app. */
export interface DevIntrospection {
  routes(): unknown;
  entities(): unknown;
  actions(): unknown;
  queries(): unknown;
  policies(): unknown;
  jobs(): unknown;
  jobInspect(name: string): unknown;
}

/** Shell-side capabilities. Satisfied by the CLI, which owns the process and the DB. */
export interface DevCapabilities {
  readonly database: DatabaseTarget;
  runQuery(sql: string, limit: number): Promise<QueryResult>;
  runMigrations(branch: string, dryRun: boolean): Promise<MigrateResult>;
  queueDepth(): Promise<readonly QueueDepth[]>;
  runTests(filter: string | undefined): Promise<TestRun>;
  tailLogs(lines: number, role: string | undefined): Promise<readonly string[]>;
  readManifest(): Promise<string>;
  explainError(code: string): ErrorExplanation | undefined;
  verify(fix: boolean): Promise<VerifyResult>;
}

export type DevHost = DevIntrospection & DevCapabilities;

const NAME_ARG: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string', description: 'Job name from jobs.inspect with no name.' } },
  additionalProperties: false,
};

/** Every dev tool, in one array so `x mcp serve` and the HTTP transport share the catalog. */
export function devTools(host: DevHost): readonly AnyMcpTool[] {
  return [
    read(
      'routes.list',
      'Route table: url, render mode, offline strategy, hydrate, budget.',
      NO_ARGS,
      () => jsonResult(host.routes()),
    ),

    read('schema.describe', 'Entities with columns, types and invariants.', NO_ARGS, () =>
      jsonResult(host.entities()),
    ),

    read(
      'policies.list',
      'Every policy: permission, subject, and where it is enforced.',
      NO_ARGS,
      () => jsonResult(host.policies()),
    ),

    read(
      'actions.describe',
      'Every action and query: input/output schema, policy, cache tags, MCP exposure.',
      NO_ARGS,
      () => jsonResult({ actions: host.actions(), queries: host.queries() }),
    ),

    read(
      'jobs.inspect',
      'Job definitions, retry policy and steps. Omit name for all jobs.',
      NAME_ARG,
      (args) => {
        const name = args['name'];
        return jsonResult(typeof name === 'string' ? host.jobInspect(name) : host.jobs());
      },
    ),

    read('queue.depth', 'Pending, running and failed counts per queue.', NO_ARGS, async () =>
      jsonResult(await host.queueDepth()),
    ),

    read('manifest.read', 'The generated x.manifest.json as text.', NO_ARGS, async () =>
      textResult(await host.readManifest()),
    ),

    read(
      'errors.explain',
      'Explain a stable X_* error code: cause, exact fix command, docs link.',
      {
        type: 'object',
        properties: { code: { type: 'string', description: 'e.g. X_DB_DRIFT' } },
        required: ['code'],
        additionalProperties: false,
      },
      (args) => {
        const code = String(args['code']);
        const explanation = host.explainError(code);
        return explanation === undefined
          ? textResult(`unknown error code: ${code}`, true)
          : jsonResult(explanation);
      },
    ),

    // ── gated: reads real data ────────────────────────────────────────────────
    {
      name: 'db.query',
      description:
        'Run ONE read-only SQL statement. Writes, multiple statements, locking clauses ' +
        'and data-modifying CTEs are refused (X_MCP_READONLY_VIOLATION), not merely discouraged.',
      scope: DEV_SCOPES.dbRead,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'One SELECT/WITH/EXPLAIN/SHOW statement.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        // Enforced here, before the host ever sees the string.
        const statement = assertReadOnlyQuery(String(args['sql']));
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 100;
        return jsonResult(await host.runQuery(statement, limit));
      },
    },

    // ── gated: changes state ──────────────────────────────────────────────────
    {
      name: 'db.migrate',
      description:
        'Apply pending migrations to the current BRANCH database. Refuses a production or ' +
        'non-branch target (X_MCP_READONLY_VIOLATION). Use ROLE=migrate to deploy.',
      scope: DEV_SCOPES.dbMigrate,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', default: false, description: 'Plan only, apply nothing.' },
        },
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const branch = assertBranchDatabase(host.database);
        const dryRun = args['dryRun'] === true;
        return jsonResult(await host.runMigrations(branch, dryRun));
      },
    },
    {
      name: 'tests.run',
      description: 'Run the test suite (executes project code). Optional substring filter.',
      scope: DEV_SCOPES.test,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: { filter: { type: 'string', description: 'Substring match on test path.' } },
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const filter = typeof args['filter'] === 'string' ? args['filter'] : undefined;
        const run = await host.runTests(filter);
        return { ...jsonResult(run), ...(run.failed > 0 ? { isError: true } : {}) };
      },
    },
    {
      name: 'verify.run',
      description:
        'Run x verify: types, lint, boundaries, migrations, manifest drift, tests, budgets. ' +
        'This is the shippable contract. `fix: true` applies safe autofixes.',
      scope: DEV_SCOPES.test,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: { fix: { type: 'boolean', default: false } },
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const result = await host.verify(args['fix'] === true);
        return { ...jsonResult(result), ...(result.ok ? {} : { isError: true }) };
      },
    },
    {
      name: 'logs.tail',
      description: 'Last N log lines, optionally for one runtime role (web/sync/worker/...).',
      scope: DEV_SCOPES.logs,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          lines: { type: 'integer', minimum: 1, maximum: 2000, default: 100 },
          role: {
            type: 'string',
            enum: ['web', 'sync', 'worker', 'scheduler', 'migrate', 'replicator'],
          },
        },
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const lines = typeof args['lines'] === 'number' ? args['lines'] : 100;
        const role = typeof args['role'] === 'string' ? args['role'] : undefined;
        return textResult((await host.tailLogs(lines, role)).join('\n'));
      },
    },
  ];
}

/** Shorthand for the introspection tools: `dev:read`, non-destructive, no role filter. */
function read(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  handle: (args: ToolArgs) => Promise<McpToolResult> | McpToolResult,
): AnyMcpTool {
  return {
    name,
    description,
    inputSchema,
    scope: DEV_SCOPES.read,
    destructive: false,
    async handle(args: ToolArgs) {
      return await handle(args);
    },
  };
}
