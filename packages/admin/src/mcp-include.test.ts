// An admin surface serves the app's own MCP tools beside its catalog: `adminMcp({ include:
// 'exposed' })` projects every action and query that declared `mcp: { expose: true }` onto the
// admin endpoint — each under the admin scope its kind needs (a query reads, an action writes) —
// at its own `path`, and the token resolver hears how the request arrived. Driven over the route.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { JsonRpcResponse, McpRequestFacts } from '@ultimat3/mcp';
import { assertIncludeCurrent } from '@ultimat3/mcp';
import { allow } from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import { type AdminMcpActor, adminMcp } from './mcp';

const memo = entity('admin_include_memo', {
  columns: { id: uuid().primaryKey(), title: text({ max: 120 }) },
});

const TOKENS: Readonly<Record<string, AdminMcpActor>> = {
  tok_read: { id: 'agent-read', roles: [], tokenScopes: ['admin:read'] },
  tok_full: { id: 'agent-full', roles: [] },
};

let published = 0;
const heard: (McpRequestFacts | undefined)[] = [];
let mcp: ReturnType<typeof adminMcp>;

beforeAll(() => {
  registerAction(
    'publishMemo',
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow('memo:publish'),
      mcp: { expose: true, description: 'Publish a memo.' },
      handle: () => {
        published += 1;
        return { ok: true };
      },
    }),
  );
  registerQuery(
    'memoFeed',
    query({
      input: t.object({}),
      policy: allow('memo:read'),
      mcp: { expose: true, description: 'Every memo.' },
      sql: () => from<{ id: string }>('memos', [{ id: 'm1' }]),
    }),
  );
  // Registered, never exposed: `include` is opt-in, as on every surface but the admin catalog.
  registerAction(
    'purgeMemos',
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow('memo:publish'),
      handle: () => ({ ok: true }),
    }),
  );
  const app = defineAdmin({
    entities: [memo],
    db: database({ memo }, { driver: memoryDriver() }),
    auth: { actor: (): AdminActor | null => null, authz: staticAuthz(['admin:destroy']) },
  });
  mcp = adminMcp({
    app,
    path: '/admin/mcp',
    include: 'exposed',
    actor: ({ token, facts }) => {
      heard.push(facts);
      return TOKENS[token ?? ''] ?? null;
    },
  });
});

afterAll(() => {
  resetActions();
  resetQueries();
  clearRegistry();
});

async function call(token: string, name: string): Promise<JsonRpcResponse> {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('adminMcp() published no HTTP route');
  const response = await route.handle(
    new Request('https://admin.test/admin/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: {} },
      }),
    }),
    { address: '127.0.0.1' },
  );
  return (await response.json()) as JsonRpcResponse;
}

const deniedScope = (response: JsonRpcResponse): unknown =>
  (response.error?.data as Record<string, unknown> | undefined)?.['scope'];

describe("adminMcp({ include: 'exposed' })", () => {
  test("serves the app's exposed tools beside the admin's own, at its own path", () => {
    const names = mcp.tools.map((tool) => tool.name);
    expect(names).toContain('publishMemo');
    expect(names).toContain('memoFeed');
    expect(names).toContain('admin.admin_include_memo.list');
    expect(names).not.toContain('purgeMemos');
    expect(mcp.route?.path).toBe('/admin/mcp');
  });

  test('a query is scoped admin:read and an action admin:write', () => {
    const scopeOf = (name: string): string | undefined =>
      mcp.tools.find((tool) => tool.name === name)?.scope;
    expect(scopeOf('memoFeed')).toBe('admin:read');
    expect(scopeOf('publishMemo')).toBe('admin:write');
  });

  test('a read-only token is refused the app action by the scope gate; a full one runs it', async () => {
    published = 0;
    expect(deniedScope(await call('tok_read', 'publishMemo'))).toBe('admin:write');
    expect(published).toBe(0);
    expect((await call('tok_full', 'publishMemo')).error).toBeUndefined();
    expect(published).toBe(1);
  });

  test('the actor resolver hears how the request arrived', async () => {
    heard.length = 0;
    await call('tok_full', 'memoFeed');
    expect(heard[0]?.address).toBe('127.0.0.1');
  });

  test('it is the include the mount checks: built after every registration, it is current', () => {
    expect(() => assertIncludeCurrent(mcp, 'apps/admin/mcp.ts')).not.toThrow();
  });
});
