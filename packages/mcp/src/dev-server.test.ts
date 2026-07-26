import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import type { DevHost, QueryResult } from './dev-server.ts';
import { DEV_SCOPES, devTools } from './dev-server.ts';
import type { DatabaseTarget } from './readonly-sql.ts';
import type { AnyMcpTool, McpCaller } from './registry.ts';
import { ToolRegistry } from './registry.ts';

const agent = { kind: 'agent', id: 'a1' } as unknown as Actor;

const EMPTY_RESULT: QueryResult = { columns: [], rows: [], rowCount: 0, truncated: false };

function fakeHost(database: DatabaseTarget): { host: DevHost; ran: string[] } {
  const ran: string[] = [];
  const host: DevHost = {
    database,
    routes: () => [{ url: '/', render: 'static' }],
    entities: () => [{ name: 'post' }],
    actions: () => [{ name: 'publishPost' }],
    queries: () => [{ name: 'liveFeed' }],
    policies: () => [{ permission: 'post:publish' }],
    jobs: () => [{ name: 'onboardOrg' }],
    jobInspect: (name) => ({ name, attempts: 5 }),
    async runQuery(sql) {
      ran.push(sql);
      return EMPTY_RESULT;
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
            docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
          }
        : undefined,
    async verify() {
      return { ok: true, steps: [{ name: 'types', ok: true }] };
    },
  };
  return { host, ran };
}

const BRANCH: DatabaseTarget = { label: 'app_branch_feat_x', branch: 'feat-x', production: false };
const SHARED: DatabaseTarget = { label: 'app_dev', branch: null, production: false };
const PROD: DatabaseTarget = { label: 'app_prod', branch: null, production: true };

function toolset(database: DatabaseTarget): {
  tool(name: string): AnyMcpTool;
  ran: string[];
} {
  const { host, ran } = fakeHost(database);
  const tools = devTools(host);
  return {
    ran,
    tool(name) {
      const found = tools.find((t) => t.name === name);
      if (found === undefined) throw new Error(`no dev tool named ${name}`);
      return found;
    },
  };
}

const caller: McpCaller = {
  actor: agent,
  scopes: new Set([DEV_SCOPES.read, DEV_SCOPES.dbRead, DEV_SCOPES.dbMigrate, DEV_SCOPES.test]),
};

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
    ).rejects.toMatchObject({ code: 'X_MCP_READONLY_VIOLATION' });
    expect(ran).toEqual([]);
  });

  test('a write hidden in a CTE or behind a second statement is refused', async () => {
    const { tool } = toolset(BRANCH);
    const cte = 'with d as (delete from posts returning id) select * from d';
    await expect(tool('db.query').handle({ sql: cte }, caller)).rejects.toMatchObject({
      code: 'X_MCP_READONLY_VIOLATION',
    });
    await expect(
      tool('db.query').handle({ sql: 'select 1; drop table posts' }, caller),
    ).rejects.toMatchObject({ code: 'X_MCP_READONLY_VIOLATION' });
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
      code: 'X_MCP_READONLY_VIOLATION',
      fix: 'x db branch <name>, then retry db.migrate',
    });
    expect(ran).toEqual([]);
  });

  test('production is refused and points at the migrate role', async () => {
    const { tool, ran } = toolset(PROD);
    await expect(tool('db.migrate').handle({}, caller)).rejects.toMatchObject({
      code: 'X_MCP_READONLY_VIOLATION',
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
    expect((found.content[0] as { text: string }).text).toContain('x db gen "add column"');
    const missing = await tool('errors.explain').handle({ code: 'X_NOPE' }, caller);
    expect(missing.isError).toBe(true);
  });
});
