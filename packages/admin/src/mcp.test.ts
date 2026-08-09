// The admin's `tools/list` is per caller, not per server: a tool the actor may not use is
// ABSENT from the catalog and answers ToolNotFound on call — never Forbidden, which would
// confirm the tool exists and hand an agent the whole entity list by probing. Driven through
// the real `McpServer`, because the filter lives in the registry, not in this package.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { type JsonRpcResponse, type McpCaller, METHOD_NOT_FOUND } from '@ultimat3/mcp';
import { defineAdmin } from './admin';
import { type AdminActor, type AdminAuthz, type AdminDecision, staticAuthz } from './authz';
import { adminMcp } from './mcp';
import type { AdminAction, AdminEntity } from './registry';

const post: AdminEntity = {
  name: 'post',
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'varchar', index: true },
    createdAt: { type: 'timestamptz', generated: true },
  },
};

const publish: AdminAction = {
  name: 'post.publish',
  permission: 'post:publish',
  entity: 'post',
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle(): Promise<unknown> {
    return { published: true };
  },
};

/** Grants per actor id — the point being that ONE server answers two callers differently. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  reader: ['admin:read', 'post:read'],
  editor: ['admin:write', 'post:read', 'post:write', 'post:publish'],
};

const perActorAuthz: AdminAuthz = {
  // Delegates to `staticAuthz` so the permission implications exercised here are the real ones.
  decide(query): AdminDecision {
    return staticAuthz(GRANTS[query.actor.id] ?? []).decide(query);
  },
};

const app = defineAdmin({
  entities: [post],
  actions: [publish],
  auth: { actor: (): AdminActor | null => null, authz: perActorAuthz },
});

// ONE server for the whole file. Every "different caller, different catalog" assertion below
// is against this same object, which is what makes it a per-connection proof.
const mcp = adminMcp({
  app,
  actor: (): AdminActor | null => null,
  requestId: (): string => 'req_test',
});

/** One caller = one request, exactly as the HTTP transport builds it. */
const caller = (id: string): McpCaller => ({ actor: agentActor({ id }), scopes: new Set() });

async function listTools(who: McpCaller): Promise<readonly string[]> {
  const response = await mcp.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, who);
  const result = response?.result as { tools: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name);
}

function callTool(
  who: McpCaller,
  name: string,
  args: Record<string, unknown> = {},
): Promise<JsonRpcResponse | null> {
  return mcp.server.handle(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    who,
  );
}

describe('the admin MCP catalog is computed per caller', () => {
  test('a read-only actor is shown only the tools it may call', async () => {
    expect(await listTools(caller('reader'))).toEqual([
      'admin.post.list',
      'admin.post.read',
      'admin.search',
    ]);

    // The server really was built with the whole catalog — the caller was shown a subset of it.
    expect(mcp.tools.map((tool) => tool.name)).toContain('admin.post.delete');
    expect(mcp.tools.length).toBeGreaterThan(3);
  });

  test('a second caller against the SAME server gets a different catalog', async () => {
    const editor = caller('editor');
    const reader = caller('reader');
    const stranger = caller('stranger');

    const first = await listTools(editor);
    const second = await listTools(reader);
    // Listed a third time after another caller ran: a cache keyed on anything but the caller
    // hands back the previous caller's answer here.
    const third = await listTools(editor);

    expect(first).toContain('admin.post.create');
    expect(first).toContain('admin.post.update');
    expect(first).toContain('admin.action.post.publish');
    // Nothing implies `post:delete`, so even the editor never sees the destructive tool.
    expect(first).not.toContain('admin.post.delete');

    expect(second).not.toContain('admin.post.create');
    expect(second).not.toContain('admin.action.post.publish');
    expect(second).not.toEqual(first);
    expect(third).toEqual(first);

    // No grants at all: an unknown actor learns nothing about the app's shape.
    expect(await listTools(stranger)).toEqual([]);
  });

  test('calling a tool the caller cannot see answers ToolNotFound, never Forbidden', async () => {
    const reader = caller('reader');
    const response = await callTool(reader, 'admin.post.delete', {
      id: 'p_1',
      confirmation: 'post:p_1',
    });

    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(response?.error?.message).toBe('tool not found: admin.post.delete');
    expect(response?.result).toBeUndefined();

    // No enumeration oracle: the answer carries no denial code, no permission, no policy
    // reason and no schema. The tool name is present only because the caller supplied it.
    const body = JSON.stringify(response);
    expect(body).not.toContain('X_ADMIN_TOOL_FORBIDDEN');
    expect(body).not.toContain('X_ADMIN_DENIED');
    expect(body).not.toContain('post:delete');
    expect(body).not.toContain('admin.policy');
    expect(body).not.toContain('confirmation');
    expect(body).not.toContain('Delete one post row');
  });

  test('a hidden action tool answers identically to a hidden crud tool', async () => {
    const response = await callTool(caller('reader'), 'admin.action.post.publish');

    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(response?.error?.message).toBe('tool not found: admin.action.post.publish');
    expect(JSON.stringify(response)).not.toContain('post:publish');
  });

  test('a tool the caller may see still runs normally', async () => {
    const response = await callTool(caller('editor'), 'admin.action.post.publish');
    const result = response?.result as
      | { content: { text: string }[]; isError?: boolean }
      | undefined;

    expect(response?.error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(result?.content[0]?.text).toBe(JSON.stringify({ published: true }, null, 2));
  });

  test('a visible read tool runs for the actor that may see it', async () => {
    const response = await callTool(caller('reader'), 'admin.search', { term: 'hello' });
    const result = response?.result as { content: { text: string }[] } | undefined;
    const payload = JSON.parse(result?.content[0]?.text ?? '{}') as { term: string };

    expect(response?.error).toBeUndefined();
    expect(payload.term).toBe('hello');
  });
});
