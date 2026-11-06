// `devTools` — the read-only SQL and branch-only migrate guards, the catalog's shape, and the read
// tools answering from the host. The executing and ui tools: ./dev-server-run.test.ts.

import { describe, expect, test } from 'bun:test';
import { DEV_SCOPES, devTools } from './dev-server';
import { BRANCH, caller, fakeHost, PROD, SHARED, textOf, toolset } from './dev-server-fixture';
import type { McpToolResult } from './registry';
import { ToolRegistry } from './registry';

describe('db.query is read-only, enforced', () => {
  test('a SELECT reaches the host', async () => {
    const { tool, ran } = toolset(BRANCH);
    await tool('db.query').handle({ sql: 'select id from posts', limit: 5 }, caller);
    expect(ran).toEqual(['select id from posts']);
  });

  test('a write statement is refused before the host sees it', async () => {
    const { tool, ran } = toolset(BRANCH);
    await expect(
      tool('db.query').handle({ sql: "update posts set title = 'x'" }, caller),
    ).rejects.toMatchObject({ code: 'X_MCP_QUERY_REJECTED' });
    expect(ran).toEqual([]);
  });

  test('a write hidden in a CTE or behind a second statement is refused', async () => {
    const { tool } = toolset(BRANCH);
    const cte = 'with d as (delete from posts returning id) select * from d';
    await expect(tool('db.query').handle({ sql: cte }, caller)).rejects.toMatchObject({
      code: 'X_MCP_QUERY_REJECTED',
    });
    await expect(
      tool('db.query').handle({ sql: 'select 1; drop table posts' }, caller),
    ).rejects.toMatchObject({ code: 'X_MCP_QUERY_REJECTED' });
  });

  test('the answer names every layer that engaged, parse and caps included', async () => {
    const { tool } = toolset(BRANCH);
    const result = await tool('db.query').handle({ sql: 'select 1' }, caller);
    const answer = JSON.parse(textOf(result) ?? '{}') as {
      guards: string[];
      truncatedBy: string | null;
    };
    expect(answer.guards).toEqual([
      'parse:single-read',
      'txn:read-only',
      'timeout:5000ms',
      'role:ultimate_readonly',
      'cap:100 rows',
      'cap:262144 bytes',
    ]);
    expect(answer.truncatedBy).toBeNull();
  });

  test('the hard row ceiling clamps a caller that asks for more than the schema allows', async () => {
    // 5000 rows offered, 1000 the ceiling — `limit` is a request, never a permission.
    const rows = Array.from({ length: 5000 }, (_, index) => [index]);
    const host = fakeHost(BRANCH).host;
    const tools = devTools({
      ...host,
      async runQuery() {
        return { columns: ['n'], rows, guards: ['txn:read-only'] };
      },
    });
    const tool = tools.find((t) => t.name === 'db.query');
    const result = await tool?.handle({ sql: 'select n from wide', limit: 9999 }, caller);
    const answer = JSON.parse(textOf(result) ?? '{}') as {
      rowCount: number;
      truncated: boolean;
      truncatedBy: string | null;
      guards: string[];
    };
    expect(answer.rowCount).toBe(1000);
    expect(answer.truncated).toBe(true);
    expect(answer.truncatedBy).toBe('rows');
    expect(answer.guards).toContain('cap:1000 rows');
  });

  test('a literal that merely looks like a write is fine', async () => {
    const { tool, ran } = toolset(BRANCH);
    await tool('db.query').handle({ sql: "select 'delete from posts' as note" }, caller);
    expect(ran.length).toBe(1);
  });
});

describe('db.migrate refuses anything but a branch database', () => {
  test('a branch database migrates', async () => {
    const { tool, ran } = toolset(BRANCH);
    await tool('db.migrate').handle({ dryRun: false }, caller);
    expect(ran).toEqual(['migrate:feat-x:false']);
  });

  test('a shared non-branch database is refused with the branch command as the fix', async () => {
    const { tool, ran } = toolset(SHARED);
    const failure = tool('db.migrate').handle({}, caller);
    await expect(failure).rejects.toMatchObject({
      code: 'X_MCP_NOT_BRANCH_DB',
      fix: 'x db branch create <name>   # then retry db.migrate',
    });
    expect(ran).toEqual([]);
  });

  test('production is refused and points at the migrate role', async () => {
    const { tool, ran } = toolset(PROD);
    await expect(tool('db.migrate').handle({}, caller)).rejects.toMatchObject({
      code: 'X_MCP_NOT_BRANCH_DB',
    });
    expect(ran).toEqual([]);
  });
});

describe('catalog shape', () => {
  test('every dev tool declares a scope, and only mutating ones are destructive', () => {
    const { host } = fakeHost(BRANCH);
    for (const tool of devTools(host)) {
      expect(tool.scope).toBeString();
    }
    const registry = new ToolRegistry().registerAll(devTools(host));
    expect(registry.verbClass('db.query')).toBe('read');
    expect(registry.verbClass('routes.list')).toBe('read');
    expect(registry.verbClass('db.migrate')).toBe('write');
    expect(registry.verbClass('tests.run')).toBe('write');
    expect(registry.verbClass('verify.run')).toBe('write');
  });

  test('errors.explain turns a stable code into cause + fix', async () => {
    const { tool } = toolset(BRANCH);
    const found = await tool('errors.explain').handle({ code: 'X_DB_DRIFT' }, caller);
    // The payload is JSON, so the fix command arrives with escaped quotes — assert on the
    // parsed object rather than the wire text, which can never match an unescaped string.
    const explained = JSON.parse(textOf(found) ?? 'null') as {
      code: string;
      cause: string;
      fix: string;
    };
    expect(explained.code).toBe('X_DB_DRIFT');
    expect(explained.cause).toBeTruthy();
    expect(explained.fix).toBe('x db gen "add column"');
    const missing = await tool('errors.explain').handle({ code: 'X_NOPE' }, caller);
    expect(missing.isError).toBe(true);
  });
});

describe('the read tools return what the host answered, each from its own source', () => {
  const parse = (result: McpToolResult): unknown => JSON.parse(textOf(result) ?? 'null');

  test('routes.list, schema.describe and policies.list do not share a source', async () => {
    const { tool } = toolset(BRANCH);
    expect(parse(await tool('routes.list').handle({}, caller))).toEqual([
      { url: '/', render: 'static' },
    ]);
    expect(parse(await tool('schema.describe').handle({}, caller))).toEqual([{ name: 'post' }]);
    expect(parse(await tool('policies.list').handle({}, caller))).toEqual([
      { permission: 'post:publish' },
    ]);
  });

  test('actions.describe answers both registries under their own keys', async () => {
    const { tool } = toolset(BRANCH);
    expect(parse(await tool('actions.describe').handle({}, caller))).toEqual({
      actions: [{ name: 'publishPost' }],
      queries: [{ name: 'liveFeed' }],
    });
  });

  test('jobs.inspect lists every job with no name, and traces one when named', async () => {
    const { tool } = toolset(BRANCH);
    expect(parse(await tool('jobs.inspect').handle({}, caller))).toEqual([{ name: 'onboardOrg' }]);
    expect(parse(await tool('jobs.inspect').handle({ name: 'onboardOrg' }, caller))).toEqual({
      name: 'onboardOrg',
      attempts: 5,
    });
    // A non-string name is the list, not `jobInspect(String(undefined))`.
    expect(parse(await tool('jobs.inspect').handle({ name: 7 }, caller))).toEqual([
      { name: 'onboardOrg' },
    ]);
  });

  test('queue.depth awaits the host rather than serialising the promise', async () => {
    const { tool } = toolset(BRANCH);
    expect(parse(await tool('queue.depth').handle({}, caller))).toEqual([
      { queue: 'default', pending: 3, running: 1, failed: 0 },
    ]);
  });

  test('manifest.read hands back the manifest as text, not as re-encoded JSON', async () => {
    const { tool } = toolset(BRANCH);
    const result = await tool('manifest.read').handle({}, caller);
    expect(textOf(result)).toBe('{"version":1}');
  });
});

describe('graph.query asks the host one question of the app graph', () => {
  test('{ node } is an impact question, { from, to } a path, under dev:read', async () => {
    const { tool, ran } = toolset(BRANCH);
    expect(tool('graph.query').scope).toBe(DEV_SCOPES.read);
    expect(tool('graph.query').destructive).toBe(false);
    const impact = await tool('graph.query').handle({ node: 'app/posts/policy.ts' }, caller);
    expect(JSON.parse(textOf(impact) ?? '{}')).toEqual({ node: 'app/posts/policy.ts', routes: [] });
    await tool('graph.query').handle({ from: 'query:postById', to: 'entity:posts' }, caller);
    expect(ran).toEqual([
      'graph:{"kind":"impact","node":"app/posts/policy.ts"}',
      'graph:{"kind":"path","from":"query:postById","to":"entity:posts"}',
    ]);
  });

  test('no question, half a path or both kinds at once is an error naming the two shapes', async () => {
    const { tool, ran } = toolset(BRANCH);
    for (const args of [{}, { from: 'a' }, { node: 'a', to: 'b' }, { node: '  ' }]) {
      const answer = await tool('graph.query').handle(args, caller);
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toContain('{ from, to }');
    }
    expect(ran).toEqual([]);
  });
});
