// The four agent tools as the catalog serves them: what reaches the host, under which scope, and
// — for `db.explain` — that no write, however hidden, is ever handed to a host that would run it.

import { describe, expect, test } from 'bun:test';
import { agentHostOf, EXPLAIN_LIMITS } from './dev-agent-tools';
import { DEV_SCOPES } from './dev-server';
import { BRANCH, caller, textOf, toolset } from './dev-server-fixture';

const json = (text: string | undefined): Record<string, unknown> =>
  JSON.parse(text ?? '{}') as Record<string, unknown>;

describe('db.explain', () => {
  test('plans a SELECT, ANALYZE only when asked, under a timeout of at most 5 s', async () => {
    const { tool, ran } = toolset(BRANCH);
    const planned = json(textOf(await tool('db.explain').handle({ sql: 'select 1' }, caller)));
    await tool('db.explain').handle({ sql: 'select 1', analyze: true }, caller);
    expect(ran).toEqual([
      'explain:5000:EXPLAIN (FORMAT JSON) select 1',
      'explain:5000:EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1',
    ]);
    expect(EXPLAIN_LIMITS.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(EXPLAIN_LIMITS.timeoutMs).toBeGreaterThan(0);
    expect(planned['plan']).toEqual([{ Plan: {} }]);
    expect(planned['analyzed']).toBe(false);
    expect(planned['guards']).toEqual([
      'parse:single-read',
      'parse:select-only',
      'txn:read-only',
      'timeout:5000ms',
      'role:ultimate_readonly',
    ]);
  });

  test.each([
    ['in a CTE', 'with d as (delete from posts returning id) select * from d'],
    ['after a ;', 'select 1; delete from posts'],
    ['after a ; inside an EXPLAIN of its own', 'select 1; explain analyze update posts set x = 1'],
  ])('a write hidden %s is refused before the host sees it', async (_where, sql) => {
    const { tool, ran } = toolset(BRANCH);
    await expect(tool('db.explain').handle({ sql, analyze: true }, caller)).rejects.toMatchObject({
      code: 'X_MCP_QUERY_REJECTED',
    });
    expect(ran).toEqual([]);
  });

  test('reads data, so it sits under db:read and is no write', () => {
    const explain = toolset(BRANCH).tool('db.explain');
    expect(explain.scope).toBe(DEV_SCOPES.dbRead);
    expect(explain.destructive).toBe(false);
  });
});

describe('docs.search, requests.statements and verify.narrow hand the host their arguments', () => {
  test('docs.search passes the question and the limit, defaulting to x docs’ five', async () => {
    const { tool, ran } = toolset(BRANCH);
    await tool('docs.search').handle({ query: 'paginate a query' }, caller);
    await tool('docs.search').handle({ query: 'keyset', limit: 2 }, caller);
    expect(ran).toEqual(['docs:5:paginate a query', 'docs:2:keyset']);
  });

  test('requests.statements reads the dev ledger under dev:logs', async () => {
    const { tool, ran } = toolset(BRANCH);
    await tool('requests.statements').handle({}, caller);
    await tool('requests.statements').handle({ requestId: 'r1', limit: 3 }, caller);
    expect(ran).toEqual(['statements:*:10', 'statements:r1:3']);
    expect(tool('requests.statements').scope).toBe(DEV_SCOPES.logs);
  });

  test('verify.narrow runs nothing: dev:read, not a write', async () => {
    const { tool, ran } = toolset(BRANCH);
    const answer = json(
      textOf(await tool('verify.narrow').handle({ file: 'apps/web/app/page.tsx' }, caller)),
    );
    expect(ran).toEqual(['narrow:apps/web/app/page.tsx']);
    expect(answer['commands']).toEqual(['x verify --only lint --json']);
    expect(tool('verify.narrow').scope).toBe(DEV_SCOPES.read);
    expect(tool('verify.narrow').destructive).toBe(false);
  });
});

// `DevCapabilities` holds the four answers as optional, so a host written against an earlier 31.x
// still compiles; what it lacks is a coded refusal on that one tool, never a crash of the catalog.
describe('a host without an agent capability', () => {
  test('answers that tool X_NOT_IMPLEMENTED and keeps the ones it has', async () => {
    const host = agentHostOf({ narrowVerify: async (file) => ({ file }) });
    expect(await host.narrowVerify('a.ts')).toEqual({ file: 'a.ts' });
    const refused: unknown = await host.searchDocs('paginate', 5).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect((refused as { cause: string }).cause).toContain('docs.search');
    await expect(host.explainQuery('EXPLAIN SELECT 1', EXPLAIN_LIMITS)).rejects.toThrow(
      'db.explain',
    );
  });
});
