// The four dev tools that answer an agent's next question without a shell round trip: `docs.search`
// (`x docs`), `db.explain` (a plan, `ANALYZE` inside the read-only transaction), `requests.statements`
// (`x dev`'s per-request statement ledger) and `verify.narrow` (what to run after editing a file).
// Each is a projection: the CLI answers through `DevAgentHost`, from the command that already exists.

import { NotImplementedError } from '@ultimat3/core';
import { EXPLAIN_GUARD, explainStatement, planOf } from './explain-sql';
import type { QueryLimits, QueryRows } from './query-limits';
import { QUERY_LIMITS } from './query-limits';
import { PARSE_GUARD } from './readonly-sql';
import type { AnyMcpTool, ToolArgs } from './registry';
import { jsonResult } from './registry';

/** The ceilings `db.explain` runs under: `db.query`'s timeout, and the one row EXPLAIN answers. */
export const EXPLAIN_LIMITS: QueryLimits = Object.freeze({ ...QUERY_LIMITS, maxRows: 1 });

/** Requests `requests.statements` reads by default and at most — the dev recorder's own scale. */
export const REQUEST_STATEMENT_LIMITS = Object.freeze({ default: 10, max: 50 });

export interface DevAgentHost {
  /** `x docs <query> --limit <n> --json`, run in process: its `summary`, `lines` and `data`. */
  searchDocs(query: string, limit: number): Promise<unknown>;
  /**
   * Run the EXPLAIN `explainStatement` built, under `db.query`'s layers 1–2 (SELECT-only role,
   * `BEGIN READ ONLY`, `limits.timeoutMs`). Refuses a production database the way `x explain` does.
   */
  explainQuery(statement: string, limits: QueryLimits): Promise<QueryRows>;
  /** The running `x dev`'s recent requests, each with its statement count and N+1 verdicts. */
  requestStatements(input: {
    readonly requestId: string | undefined;
    readonly limit: number;
  }): Promise<unknown>;
  /** The `x verify --changed` plan for ONE file, as the commands that run it. Runs nothing. */
  narrowVerify(file: string): Promise<unknown>;
}

/** The host's capability, or one that refuses: `DevCapabilities` holds these as optional. */
const absent = (tool: string, capability: string) => async (): Promise<never> => {
  throw new NotImplementedError({
    cause: `${tool} on a dev host with no ${capability} is not implemented in this build`,
    fix: 'x mcp serve --transport stdio   # the CLI host answers every dev tool',
  });
};

/** A whole `DevAgentHost` over one that may lack some of its four answers. */
export function agentHostOf(host: Partial<DevAgentHost>): DevAgentHost {
  return {
    searchDocs: host.searchDocs?.bind(host) ?? absent('docs.search', 'searchDocs'),
    explainQuery: host.explainQuery?.bind(host) ?? absent('db.explain', 'explainQuery'),
    requestStatements:
      host.requestStatements?.bind(host) ?? absent('requests.statements', 'requestStatements'),
    narrowVerify: host.narrowVerify?.bind(host) ?? absent('verify.narrow', 'narrowVerify'),
  };
}

const text = (args: ToolArgs, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const count = (args: ToolArgs, key: string, fallback: number): number => {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
};

/** The scopes these tools sit under, handed in by `devTools` so `DEV_SCOPES` stays one table. */
export interface AgentToolScopes {
  readonly read: string;
  readonly logs: string;
  readonly dbRead: string;
}

export function agentTools(host: DevAgentHost, scopes: AgentToolScopes): readonly AnyMcpTool[] {
  return [
    {
      name: 'docs.search',
      description:
        'x docs as a tool: the installed framework docs (packages and wiki), ranked for a question, ' +
        'a topic or a symbol. An X_* code is redirected to errors.explain. Offline; runs nothing.',
      scope: scopes.read,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'e.g. "paginate a query"' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        return jsonResult(
          await host.searchDocs(text(args, 'query') ?? '', count(args, 'limit', 5)),
        );
      },
    },
    {
      name: 'db.explain',
      description:
        'The query plan of ONE SELECT or WITH … SELECT, as EXPLAIN (FORMAT JSON). `analyze: true` ' +
        'executes it — inside the same SELECT-only role and READ ONLY transaction as db.query, ' +
        `under its ${QUERY_LIMITS.timeoutMs}ms timeout. Writes, a second statement and ` +
        'data-modifying CTEs are refused (X_MCP_QUERY_REJECTED); a production database too.',
      scope: scopes.dbRead,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The bare SELECT; db.explain writes the EXPLAIN.' },
          analyze: { type: 'boolean', default: false, description: 'Execute for real timings.' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        const analyze = args['analyze'] === true;
        // Screened here, before the host sees a byte — the same place `db.query` screens.
        const statement = explainStatement(String(args['sql']), analyze);
        const rows = await host.explainQuery(statement, EXPLAIN_LIMITS);
        return jsonResult({
          analyzed: analyze,
          statement,
          plan: planOf(rows.rows[0]?.[0]),
          guards: [PARSE_GUARD, EXPLAIN_GUARD, ...rows.guards],
        });
      },
    },
    {
      name: 'requests.statements',
      description:
        "Statements per request from the running x dev's ledger: each recent request with its SQL " +
        'count, repeated statements and N+1 verdicts (X_N_PLUS_ONE_QUERY/WRITE, with the fix). ' +
        'Pass requestId for one request. Needs x dev running.',
      scope: scopes.logs,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string', description: 'One request; omit for the most recent.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: REQUEST_STATEMENT_LIMITS.max,
            default: REQUEST_STATEMENT_LIMITS.default,
          },
        },
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        return jsonResult(
          await host.requestStatements({
            requestId: text(args, 'requestId'),
            limit: count(args, 'limit', REQUEST_STATEMENT_LIMITS.default),
          }),
        );
      },
    },
    {
      name: 'verify.narrow',
      description:
        'What to run after editing one file: the x verify steps its change selects (the ' +
        '--changed plan) and the narrowest commands for them. Runs nothing; verify.run runs them.',
      scope: scopes.read,
      destructive: false,
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            minLength: 1,
            description: 'App-relative, e.g. apps/web/app/page.tsx',
          },
        },
        required: ['file'],
        additionalProperties: false,
      },
      async handle(args: ToolArgs) {
        return jsonResult(await host.narrowVerify(text(args, 'file') ?? ''));
      },
    },
  ];
}
