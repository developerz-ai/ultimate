// The admin's MCP tools carry real scopes: a token resolved to `tokenScopes: ['admin:read']` runs
// the read tools and the `readonly` actions, and is refused every write BY THE SCOPE GATE — before
// the policy, whatever the actor's own grants. Driven through the published HTTP route, because
// the token-to-scopes hop is `resolveToken` and the gate is the registry's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { JsonRpcResponse } from '@ultimat3/mcp';
import { defineAdmin } from './admin';
import { type AdminActor, staticAuthz } from './authz';
import { type AdminMcpActor, adminMcp } from './mcp';
import { adminTokenScopes } from './mcp-scopes';
import type { AdminAction } from './registry';

const note = entity('admin_scope_note', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

let ran: string[] = [];
const action = (name: string, extra: Partial<AdminAction> = {}): AdminAction => ({
  name,
  permission: `admin_scope_note:${name}`,
  ...extra,
  async handle(): Promise<unknown> {
    ran.push(name);
    return { ran: name };
  },
});

/** The actor may do everything: the scope is the only thing that can say no below. */
const authz = staticAuthz([
  'admin:destroy',
  'admin_scope_note:read',
  'admin_scope_note:write',
  'admin_scope_note:delete',
  'admin_scope_note:verify',
  'admin_scope_note:publish',
]);

const TOKENS: Readonly<Record<string, AdminMcpActor>> = {
  tok_read: { id: 'agent-read', roles: [], tokenScopes: ['admin:read'] },
  tok_write: { id: 'agent-write', roles: [], tokenScopes: ['admin:write'] },
  tok_full: { id: 'agent-full', roles: [] },
};

let mcp: ReturnType<typeof adminMcp>;
beforeAll(() => {
  const app = defineAdmin({
    entities: [note],
    db: database({ note }, { driver: memoryDriver() }),
    actions: [action('verify', { readonly: true }), action('publish')],
    auth: { actor: (): AdminActor | null => null, authz },
  });
  mcp = adminMcp({ app, actor: ({ token }) => TOKENS[token ?? ''] ?? null });
});

async function rpc(token: string, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('adminMcp() published no HTTP route');
  const response = await route.handle(
    new Request('https://admin.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as JsonRpcResponse;
}

const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(token, 'tools/call', { name, arguments: args });

const deniedScope = (response: JsonRpcResponse): unknown =>
  (response.error?.data as Record<string, unknown> | undefined)?.['scope'];

describe('admin MCP tools carry the admin permission they need as their scope', () => {
  test('each tool is scoped read, write or destroy by what it does', () => {
    const scopeOf = (name: string): string | undefined =>
      mcp.tools.find((tool) => tool.name === name)?.scope;
    expect(scopeOf('admin.admin_scope_note.list')).toBe('admin:read');
    expect(scopeOf('admin.admin_scope_note.read')).toBe('admin:read');
    expect(scopeOf('admin.search')).toBe('admin:read');
    expect(scopeOf('admin.action.verify')).toBe('admin:read');
    expect(scopeOf('admin.admin_scope_note.create')).toBe('admin:write');
    expect(scopeOf('admin.admin_scope_note.update')).toBe('admin:write');
    expect(scopeOf('admin.action.publish')).toBe('admin:write');
    expect(scopeOf('admin.admin_scope_note.delete')).toBe('admin:destroy');
  });

  test('a token scoped admin:read runs a read tool and a readonly action', async () => {
    ran = [];
    expect((await call('tok_read', 'admin.admin_scope_note.list')).error).toBeUndefined();
    const verified = await call('tok_read', 'admin.action.verify');
    expect(verified.error).toBeUndefined();
    expect(ran).toEqual(['verify']);
  });

  test('a token scoped admin:read is refused every write by the scope gate, before the policy', async () => {
    ran = [];
    const published = await call('tok_read', 'admin.action.publish');
    expect((published.error?.data as Record<string, unknown> | undefined)?.['code']).toBe(
      'X_MCP_SCOPE_DENIED',
    );
    expect(deniedScope(published)).toBe('admin:write');
    expect(
      deniedScope(await call('tok_read', 'admin.admin_scope_note.create', { title: 'x' })),
    ).toBe('admin:write');
    expect(deniedScope(await call('tok_read', 'admin.admin_scope_note.delete', { id: 'n' }))).toBe(
      'admin:destroy',
    );
    // The handler never ran: the actor's own grants would have allowed it.
    expect(ran).toEqual([]);
  });

  test('admin:write implies admin:read, and still not admin:destroy', async () => {
    ran = [];
    expect((await call('tok_write', 'admin.action.publish')).error).toBeUndefined();
    expect((await call('tok_write', 'admin.action.verify')).error).toBeUndefined();
    expect(deniedScope(await call('tok_write', 'admin.admin_scope_note.delete', { id: 'n' }))).toBe(
      'admin:destroy',
    );
    expect(ran).toEqual(['publish', 'verify']);
  });

  test('a token that states no scopes is as strong as its actor', async () => {
    ran = [];
    expect((await call('tok_full', 'admin.action.publish')).error).toBeUndefined();
    expect(ran).toEqual(['publish']);
    expect([...adminTokenScopes(undefined)].sort()).toEqual([
      'admin:destroy',
      'admin:read',
      'admin:write',
    ]);
  });

  test('a scope that is no admin permission grants nothing', () => {
    expect([...adminTokenScopes(['posts:write', 'admin:read'])]).toEqual(['admin:read']);
    expect([...adminTokenScopes([])]).toEqual([]);
  });
});
