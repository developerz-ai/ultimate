// What `tools/list` tells a client beyond name/description/inputSchema (MCP 2025-06-18) and what
// `initialize` advises: `title`, the four annotation hints derived from the primitive's kind and
// overridable in its `mcp` block, `outputSchema` + `structuredContent` where the answer's shape is
// declared, and per-caller `instructions`. Failure and edge cases first.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetActions } from '@ultimat3/action';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller, ToolListEntry } from './registry';
import type { McpServer } from './server';
import { mcpServer } from './server';

const owner: McpCaller = {
  actor: agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] }),
  role: 'staff',
  scopes: new Set<string>(),
};
const customer: McpCaller = { ...owner, role: 'customer' };

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

const listed = async (server: McpServer, who: McpCaller = owner) => {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, who);
  const tools = (response?.result as { tools?: ToolListEntry[] } | undefined)?.tools ?? [];
  return new Map(tools.map((tool) => [tool.name, tool]));
};

const callTool = (server: McpServer, name: string, args: Record<string, unknown> = {}) =>
  inRequest(() =>
    server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      owner,
    ),
  );

const initialize = async (server: McpServer, who: McpCaller) =>
  (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, who))
    ?.result as Record<string, unknown>;

beforeEach(() => {
  definePermissions(['post:publish', 'post:read', 'post:delete']);
  defineRoles({ owner: { grants: ['post:publish', 'post:read', 'post:delete'] } });
  registerAction(
    'publishPost',
    action({
      input: t.object({ postId: t.string }),
      output: t.object({ ok: t.boolean, at: t.string.min(3) }),
      policy: can('post:publish'),
      idempotent: true,
      mcp: { expose: true, description: 'Publish a draft post', title: 'Publish post' },
      handle: () => ({ ok: true, at: '2026-09-29' }),
    }),
  );
  registerAction(
    'tagPost',
    action({
      input: t.object({ postId: t.string }),
      output: t.array(t.string),
      policy: can('post:publish'),
      mcp: {
        expose: true,
        description: 'Tag a post',
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      handle: () => ['a'],
    }),
  );
  registerQuery(
    'listPosts',
    query({
      input: t.object({}),
      rows: t.object({ id: t.string, title: t.string }),
      policy: can('post:read'),
      mcp: { expose: true, description: 'Posts' },
      sql: () => from<{ id: string; title: string }>('posts', [{ id: 'p1', title: 'Hi' }]),
    }),
  );
  registerQuery(
    'countPosts',
    query({
      input: t.object({}),
      policy: can('post:read'),
      mcp: { expose: true, description: 'Count', annotations: { openWorldHint: false } },
      sql: () => from<{ n: number }>('posts', [{ n: 1 }]),
    }),
  );
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearPermissions();
  clearRoles();
});

describe('annotations — derived from the kind, overridden key by key', () => {
  test('an action is a write a client should confirm; idempotent: true says a repeat is safe', async () => {
    const tools = await listed(defineAppMcp({ include: 'exposed' }).server);
    expect(tools.get('publishPost')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  test('the author overrides one hint without losing the others', async () => {
    const tools = await listed(defineAppMcp({ include: 'exposed' }).server);
    expect(tools.get('tagPost')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  test('a query is read-only', async () => {
    const tools = await listed(defineAppMcp({ include: 'exposed' }).server);
    expect(tools.get('listPosts')?.annotations).toEqual({ readOnlyHint: true });
    expect(tools.get('countPosts')?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  test('the meta tools carry their own: two reads and a door that must be assumed to write', async () => {
    const server = defineAppMcp({
      include: 'exposed',
      surface: 'meta',
      groups: { posts: { description: 'Posts', tools: ['publishPost', 'listPosts'] } },
    }).server;
    const tools = await listed(server);
    expect(tools.get('list_resources')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('describe_resource')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('manage_resource')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

describe('title', () => {
  test('published when declared, absent otherwise', async () => {
    const tools = await listed(defineAppMcp({ include: 'exposed' }).server);
    expect(tools.get('publishPost')?.title).toBe('Publish post');
    expect(tools.get('tagPost')).not.toHaveProperty('title');
  });
});

describe('outputSchema + structuredContent', () => {
  test('an output that is not an object publishes no outputSchema and answers text only', async () => {
    const server = defineAppMcp({ include: 'exposed' }).server;
    expect((await listed(server)).get('tagPost')).not.toHaveProperty('outputSchema');
    const response = await callTool(server, 'tagPost', { postId: 'p1' });
    expect(response?.result).toEqual({ content: [{ type: 'text', text: '["a"]' }] });
  });

  test('a query without declared rows publishes no outputSchema', async () => {
    const server = defineAppMcp({ include: 'exposed' }).server;
    expect((await listed(server)).get('countPosts')).not.toHaveProperty('outputSchema');
  });

  test("an action's object output is published as structure only — no bound a client could hold it to", async () => {
    const tools = await listed(defineAppMcp({ include: 'exposed' }).server);
    expect(tools.get('publishPost')?.outputSchema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' }, at: { type: 'string' } },
      required: ['ok', 'at'],
    });
  });

  test('a call answers structuredContent beside the compact text', async () => {
    const server = defineAppMcp({ include: 'exposed' }).server;
    const response = await callTool(server, 'publishPost', { postId: 'p1' });
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: '{"ok":true,"at":"2026-09-29"}' }],
      structuredContent: { ok: true, at: '2026-09-29' },
    });
  });

  test("a query's declared rows are published as { rows } and answered so", async () => {
    const server = defineAppMcp({ include: 'exposed' }).server;
    expect((await listed(server)).get('listPosts')?.outputSchema).toEqual({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, title: { type: 'string' } },
            required: ['id', 'title'],
          },
        },
      },
      required: ['rows'],
    });
    const response = await callTool(server, 'listPosts');
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: '[{"id":"p1","title":"Hi"}]' }],
      structuredContent: { rows: [{ id: 'p1', title: 'Hi' }] },
    });
  });

  test('a refusal carries no structuredContent', async () => {
    const server = defineAppMcp({ include: 'exposed' }).server;
    const response = await callTool(server, 'publishPost', {});
    expect(response?.result).not.toHaveProperty('structuredContent');
    expect((response?.result as { isError?: boolean } | undefined)?.isError).toBe(true);
  });
});

describe('initialize — instructions', () => {
  test('none declared: the handshake is exactly what it was', async () => {
    const result = await initialize(mcpServer(), owner);
    expect(result).not.toHaveProperty('instructions');
  });

  test('a function that throws, answers empty or answers a non-string sends none — and the handshake stands', async () => {
    for (const instructions of [
      () => {
        throw new TypeError('boom');
      },
      () => '   ',
      () => 42 as unknown as string,
      () => undefined,
    ]) {
      const result = await initialize(mcpServer({ instructions }), owner);
      expect(result).not.toHaveProperty('instructions');
      expect(result['protocolVersion']).toBeDefined();
    }
  });

  test('a string is sent to every caller', async () => {
    const server = mcpServer({ instructions: 'Start with docs({}).' });
    expect((await initialize(server, customer))['instructions']).toBe('Start with docs({}).');
  });

  test('a function answers per caller population', async () => {
    const server = defineAppMcp({
      include: 'exposed',
      instructions: (caller) =>
        caller.role === 'staff' ? 'Staff: list_resources({}) first.' : 'Start with docs({}).',
    }).server;
    expect((await initialize(server, owner))['instructions']).toBe(
      'Staff: list_resources({}) first.',
    );
    expect((await initialize(server, customer))['instructions']).toBe('Start with docs({}).');
  });
});
