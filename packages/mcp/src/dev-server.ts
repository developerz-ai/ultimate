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

import type { QueryLimits, QueryRows } from './query-limits';
import { capQueryRows, DEFAULT_QUERY_ROWS, QUERY_LIMITS, resolveQueryLimits } from './query-limits';
import type { DatabaseTarget } from './readonly-sql';
import { assertBranchDatabase, assertReadOnlyQuery, PARSE_GUARD } from './readonly-sql';
import type { AnyMcpTool, McpToolResult, ToolArgs } from './registry';
import { jsonResult, textResult } from './registry';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

/** Scopes the dev server gates on. A token carries a subset; the rest is invisible. */
export const DEV_SCOPES = {
  read: 'dev:read',
  test: 'dev:test',
  logs: 'dev:logs',
  dbRead: 'db:read',
  dbMigrate: 'db:migrate',
} as const;

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
/**
 * The viewports `ui.shot` names. Named, not free, so two agents (or one agent twice) photograph
 * the same thing and can compare the pictures; `{ width, height }` stays available for the one
 * case a name does not cover.
 */
export const UI_VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;
export type UiViewportName = keyof typeof UI_VIEWPORTS;
export type UiColorScheme = 'light' | 'dark';

export interface UiShotInput {
  /** The route's path — `/dashboard`, `/links/abc123` — never a full URL. */
  readonly route: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /**
   * What `prefers-color-scheme` the page sees. Emulated on the page BEFORE navigation, so a
   * capture never depends on the box that took it; an app whose boot script honours a stored
   * choice still wins, because the stored choice is what "explicit" means.
   */
  readonly colorScheme: UiColorScheme;
  readonly fullPage: boolean;
}

/**
 * What a picture is worth: the file, and the verdict beside it. The verdict is the SAME shape
 * `x shot` writes to `verdict.json` — console lines, page errors, network refusals, whether every
 * island mounted — so a picture with a hydration error is a finding, never merely a picture.
 * The PNG is a PATH, never inlined bytes: an agent reads the picture it wants and pays for one.
 */
export interface UiShotResult {
  readonly ok: boolean;
  readonly image: string;
  readonly verdictFile: string;
  readonly verdict: unknown;
}

export interface UiIslandInput {
  /** The island's name as `x shot --island <name>` takes it. */
  readonly island: string;
  /** One declared state, or every state the island declares. */
  readonly state?: string | undefined;
}

export interface UiIslandResult {
  readonly ok: boolean;
  readonly dir: string;
  readonly verdictFile: string;
  readonly verdict: unknown;
}

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
  /**
   * Run one already-parsed read-only statement under layers 1–2 (a SELECT-only role, a
   * `BEGIN READ ONLY` transaction, `limits.timeoutMs`) and return at most `limits.maxRows + 1`
   * rows — the extra row is how the tool tells `truncated` without a second count query.
   */
  runQuery(sql: string, limits: QueryLimits): Promise<QueryRows>;
  runMigrations(branch: string, dryRun: boolean): Promise<MigrateResult>;
  queueDepth(): Promise<readonly QueueDepth[]>;
  runTests(filter: string | undefined): Promise<TestRun>;
  tailLogs(lines: number, role: string | undefined): Promise<readonly string[]>;
  readManifest(): Promise<string>;
  explainError(code: string): ErrorExplanation | undefined;
  verify(fix: boolean): Promise<VerifyResult>;
  /**
   * Photograph one route against the running dev server (or a scratch one), the way `x shot
   * <route>` does, at a viewport and colour scheme the caller names. Refuses a route that declares
   * no JS budget: a picture of a route nobody has finished is a picture of a draft, and the gate
   * refuses the same route as `X_BUDGET_UNMEASURED`.
   */
  shotRoute(input: UiShotInput): Promise<UiShotResult>;
  /** `x shot --island <name> [--state <id>]` as a tool: every declared state, photographed and judged. */
  shotIsland(input: UiIslandInput): Promise<UiIslandResult>;
}

export type DevHost = DevIntrospection & DevCapabilities;

const NAME_ARG: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string', description: 'Job name from jobs.inspect with no name.' } },
  additionalProperties: false,
};

/**
 * An explicit `width`+`height` wins over the name; one of the pair alone is not a viewport and
 * falls back to the name (default `desktop`) rather than to a half-sized frame.
 */
export function viewportOf(args: ToolArgs): { readonly width: number; readonly height: number } {
  const width = args['width'];
  const height = args['height'];
  if (typeof width === 'number' && typeof height === 'number') return { width, height };
  const name = args['viewport'];
  const named = typeof name === 'string' && Object.hasOwn(UI_VIEWPORTS, name) ? name : 'desktop';
  return UI_VIEWPORTS[named as UiViewportName];
}

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
        'and data-modifying CTEs are refused (X_MCP_QUERY_REJECTED), not merely discouraged. ' +
        `Runs as a SELECT-only role in a READ ONLY transaction, capped at ${QUERY_LIMITS.maxRows} ` +
        `rows, ${QUERY_LIMITS.maxBytes} bytes and ${QUERY_LIMITS.timeoutMs}ms; the answer's ` +
        '`guards` names the defences that engaged and `truncatedBy` names any cap that bit.',
      scope: DEV_SCOPES.dbRead,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'One SELECT/WITH/EXPLAIN/SHOW statement.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: QUERY_LIMITS.maxRows,
            default: DEFAULT_QUERY_ROWS,
          },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        // Layer 3, here, before the host ever sees the string; layers 1–2 in the host; layer 4
        // on the way out. The caps run in this handler rather than in the host because a host
        // that forgets them is a host that answers a million rows into a model's context.
        const statement = assertReadOnlyQuery(String(args['sql']));
        const limits = resolveQueryLimits(args['limit']);
        const rows = await host.runQuery(statement, limits);
        return jsonResult(capQueryRows({ ...rows, guards: [PARSE_GUARD, ...rows.guards] }, limits));
      },
    },

    // ── gated: changes state ──────────────────────────────────────────────────
    {
      name: 'db.migrate',
      description:
        'Apply pending migrations to the current BRANCH database. Refuses a production or ' +
        'non-branch target (X_MCP_NOT_BRANCH_DB). Use ROLE=migrate to deploy.',
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
      name: 'ui.shot',
      description:
        'Photograph one route at a named viewport (phone/tablet/desktop) or an explicit size, ' +
        'in light or dark, against the running dev server. Returns the PNG path and the same ' +
        'verdict x shot writes: console, page errors, refused requests, whether every island ' +
        'mounted. Refuses a route with no declared JS budget. Launches a browser.',
      scope: DEV_SCOPES.test,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route path, e.g. /dashboard.' },
          viewport: {
            type: 'string',
            enum: Object.keys(UI_VIEWPORTS),
            default: 'desktop',
            description: 'phone 390×844, tablet 820×1180, desktop 1440×900.',
          },
          width: { type: 'integer', minimum: 320, maximum: 3840 },
          height: { type: 'integer', minimum: 320, maximum: 2160 },
          theme: { type: 'string', enum: ['light', 'dark'], default: 'dark' },
          fullPage: { type: 'boolean', default: true },
        },
        required: ['route'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const route = typeof args['route'] === 'string' ? args['route'] : '';
        const result = await host.shotRoute({
          route,
          viewport: viewportOf(args),
          colorScheme: args['theme'] === 'light' ? 'light' : 'dark',
          fullPage: args['fullPage'] !== false,
        });
        return { ...jsonResult(result), ...(result.ok ? {} : { isError: true }) };
      },
    },
    {
      name: 'ui.island',
      description:
        'Photograph an island in every state its *.island.states.ts declares (or one state), ' +
        'as x shot --island does: PNGs plus a verdict per state. Launches a browser.',
      scope: DEV_SCOPES.test,
      destructive: true,
      inputSchema: {
        type: 'object',
        properties: {
          island: { type: 'string', description: 'Island name, e.g. links-table.' },
          state: { type: 'string', description: 'One declared state id; omit for all.' },
        },
        required: ['island'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const island = typeof args['island'] === 'string' ? args['island'] : '';
        const state = typeof args['state'] === 'string' ? args['state'] : undefined;
        const result = await host.shotIsland({ island, ...(state === undefined ? {} : { state }) });
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
