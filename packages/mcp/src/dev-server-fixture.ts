/**
 * The doubles both `devTools` suites drive: a host answering every `DevHost` member from fixed
 * data and recording what ran, the three database targets, a tool lookup and a caller holding
 * every dev scope. Test-only — excluded from the tarball by `package.json`'s `-fixture.ts` negation.
 */

import { expect } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { DevHost } from './dev-server';
import { DEV_SCOPES, devTools } from './dev-server';
import type { QueryRows } from './query-limits';
import type { DatabaseTarget } from './readonly-sql';
import type { AnyMcpTool, McpCaller, McpToolResult } from './registry';

const agent = { kind: 'agent', id: 'a1' } as unknown as Actor;

/**
 * The first block's text. `ContentBlock` is a UNION — a `resource` block carries a `uri` and no
 * text — so the narrowing is part of the assertion: a tool that answered a resource where the test
 * expects text reads as `undefined` here rather than compiling against a field it never had.
 */
export const textOf = (result: McpToolResult | undefined): string | undefined => {
  const first = result?.content[0];
  return first?.type === 'text' ? first.text : undefined;
};

/** What layers 1–2 hand back when they both engaged and the statement matched nothing. */
const EMPTY_ROWS: QueryRows = {
  columns: [],
  rows: [],
  guards: ['txn:read-only', 'timeout:5000ms', 'role:ultimate_readonly'],
};

export function fakeHost(database: DatabaseTarget): { host: DevHost; ran: string[] } {
  const ran: string[] = [];
  const host: DevHost = {
    database,
    routes: () => [{ url: '/', render: 'static' }],
    entities: () => [{ name: 'post', table: 'posts' }],
    actions: () => [{ name: 'publishPost' }],
    queries: () => [{ name: 'liveFeed' }],
    policies: () => [{ permission: 'post:publish' }],
    jobs: () => [{ name: 'onboardOrg' }],
    jobInspect: (name) => ({ name, attempts: 5 }),
    async queryGraph(question) {
      ran.push(`graph:${JSON.stringify(question)}`);
      return { node: question.kind === 'impact' ? question.node : question.from, routes: [] };
    },
    async runQuery(sql) {
      ran.push(sql);
      return EMPTY_ROWS;
    },
    async explainQuery(statement, limits) {
      ran.push(`explain:${limits.timeoutMs}:${statement}`);
      return { columns: ['QUERY PLAN'], rows: [['[{"Plan":{}}]']], guards: EMPTY_ROWS.guards };
    },
    async searchDocs(query, limit) {
      ran.push(`docs:${limit}:${query}`);
      return { summary: 'one match', data: { matches: [{ topic: 'query' }] } };
    },
    async requestStatements({ requestId, limit }) {
      ran.push(`statements:${requestId ?? '*'}:${limit}`);
      return { requests: [] };
    },
    async narrowVerify(file) {
      ran.push(`narrow:${file}`);
      return { file, commands: ['x verify --only lint --json'] };
    },
    async runMigrations(branch, dryRun) {
      ran.push(`migrate:${branch}:${String(dryRun)}`);
      return { branch, applied: ['0001_init'], pending: [] };
    },
    async queueDepth() {
      return [{ queue: 'default', pending: 3, running: 1, failed: 0 }];
    },
    async runTests() {
      return { passed: 2, failed: 0, skipped: 0, durationMs: 12, failures: [] };
    },
    async tailLogs(lines) {
      return Array.from({ length: lines }, (_, i) => `line ${i}`);
    },
    async readManifest() {
      return '{"version":1}';
    },
    explainError: (code) =>
      code === 'X_DB_DRIFT'
        ? {
            code,
            cause: 'schema differs from migrations',
            fix: 'x db gen "add column"',
            docs: ERROR_DOCS_URL,
          }
        : undefined,
    async verify() {
      return { ok: true, steps: [{ name: 'types', ok: true }] };
    },
    async shotRoute(input) {
      ran.push(
        `shot:${input.route}:${input.viewport.width}x${input.viewport.height}:${input.colorScheme}`,
      );
      return { ok: true, image: '/x/shot.png', verdictFile: '/x/verdict.json', verdict: {} };
    },
    async shotIsland(input) {
      ran.push(`island:${input.island}:${input.state ?? '*'}`);
      return { ok: true, dir: '/x/island', verdictFile: '/x/island/verdict.json', verdict: {} };
    },
    interactRoute: async (input) => ({
      ...{ ok: true, route: input.route, finalUrl: '', image: '', verdictFile: '', verdict: {} },
      steps: [],
    }),
    async diffShots({ before, after }) {
      const changedBox = { x: 1, y: 1, width: 1, height: 1 };
      const counts = { width: 2, height: 2, changedPixels: 1, changedPercent: 25 };
      return { ok: true, before, after, ...counts, changedBox, diff: '/x/diff.png' };
    },
    async inspectRoute(input) {
      ran.push(
        `inspect:${input.route}:${input.viewport.width}x${input.viewport.height}:${input.colorScheme}:` +
          `${input.selectors.join(',')}:${input.styles.join(',')}:${String(input.a11y)}:${String(input.activeElement)}`,
      );
      return {
        ok: true,
        route: input.route,
        finalUrl: `http://localhost:3000${input.route}`,
        title: 'Dash',
        theme: 'dark',
        activeElement: null,
        islands: null,
        consoleErrors: [],
        pageErrors: [],
        refused: 0,
        selectors: input.selectors.map((selector) => ({
          selector,
          valid: true,
          count: 0,
          truncated: false,
          matches: [],
        })),
        image: '/x/inspect/shot.png',
        verdictFile: '/x/inspect/verdict.json',
        truncated: false,
        droppedStyles: [],
      };
    },
  };
  return { host, ran };
}

export const BRANCH: DatabaseTarget = {
  label: 'app_branch_feat_x',
  branch: 'feat-x',
  production: false,
};
export const SHARED: DatabaseTarget = { label: 'app_dev', branch: null, production: false };
export const PROD: DatabaseTarget = { label: 'app_prod', branch: null, production: true };

export function toolset(database: DatabaseTarget): {
  tool(name: string): AnyMcpTool;
  ran: string[];
} {
  const { host, ran } = fakeHost(database);
  const tools = devTools(host);
  return {
    ran,
    tool(name) {
      const found = tools.find((t) => t.name === name);
      // An assertion, not a bare `throw new Error`: a missing tool is a failed expectation about
      // the catalog, and `expect.unreachable` returns `never`, which narrows `found` below.
      if (found === undefined) expect.unreachable(`no dev tool named ${name}`);
      return found;
    },
  };
}

export const caller: McpCaller = {
  actor: agent,
  scopes: new Set([DEV_SCOPES.read, DEV_SCOPES.dbRead, DEV_SCOPES.dbMigrate, DEV_SCOPES.test]),
};
