// The META surface — `surface: 'meta'` + `groups:` — as a real app declares it.
//
// The claim under test is that the meta tools are a second DOOR, never a second PATH: the catalog
// stays constant, a hidden tool is absent through either door, and `manage_resource` answers
// byte-for-byte what the flat `tools/call` answers for the same input — success, scope refusal,
// policy refusal and an awaiting-confirmation write alike. Failure cases first.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { oneLineParams } from './meta-surface';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult } from './registry';
import { createMcpServer, type McpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, NO_ARGS } from './wire';

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const manage = (resource: string, act: string, params?: Record<string, unknown>) =>
  call('manage_resource', {
    resource,
    action: act,
    ...(params === undefined ? {} : { params }),
  });
const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };

const listedNames = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );
const resultJson = (response: JsonRpcResponse | null): Record<string, unknown> => {
  const text = (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]
    ?.text;
  return JSON.parse(text ?? 'null') as Record<string, unknown>;
};

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

const owner = agentActor({ id: 'agent-owner', orgId: 'o1', roles: ['owner'] });
const member = agentActor({ id: 'agent-member', orgId: 'o1', roles: ['member'] });

/** `staff` → meta; everyone else flat. The population switch the app writes. */
const caller = (
  actor: typeof owner,
  role: string,
  scopes: readonly string[] = [],
  surface: 'meta' | 'flat' = 'meta',
): McpCaller => ({
  actor,
  role: `${surface}:${role}`,
  scopes: new Set(scopes),
});
const metaOwner = (scopes: readonly string[] = []) => caller(owner, 'owner', scopes);
const metaMember = (scopes: readonly string[] = []) => caller(member, 'member', scopes);
const flatOwner = (scopes: readonly string[] = []) => caller(owner, 'owner', scopes, 'flat');
const flatMember = (scopes: readonly string[] = []) => caller(member, 'member', scopes, 'flat');

const bySurface = (c: McpCaller): 'meta' | 'flat' =>
  c.role?.startsWith('meta:') === true ? 'meta' : 'flat';
const ownerRoles = ['meta:owner', 'flat:owner'];

let published = 0;

beforeEach(() => {
  published = 0;
  definePermissions(['post:publish', 'post:read', 'org:administer']);
  defineRoles({
    owner: { grants: ['post:publish', 'post:read', 'org:administer'] },
    member: { grants: ['post:read'] },
  });
  registerAction(
    'publishPost',
    action({
      input: t.object({ postId: t.string }),
      output: t.object({ ok: t.boolean, status: t.string }),
      policy: can('post:publish'),
      mcp: { expose: true, description: 'Publish a draft post' },
      handle: () => {
        published += 1;
        return { ok: true, status: 'awaiting_confirmation' };
      },
    }),
  );
  registerAction(
    'transferOrg',
    action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: can('org:administer'),
      mcp: { expose: true, description: 'Transfer the org', visibleTo: ownerRoles },
      handle: () => ({ ok: true }),
    }),
  );
  registerQuery(
    'listPosts',
    query({
      input: t.object({
        status_eq: t.optional(t.string),
        title_cont: t.optional(t.string),
        sort: t.optional(t.string),
        cursor: t.optional(t.string),
        limit: t.optional(t.number.int()),
      }),
      policy: can('post:read'),
      mcp: {
        expose: true,
        description: 'Posts, filtered',
        listParams: { filters: { status: ['_eq'], title: ['_cont'] }, sort: ['createdAt'] },
      },
      sql: () => from<{ id: string }>('posts', [{ id: 'p1' }, { id: 'p2' }]),
    }),
  );
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearPermissions();
  clearRoles();
});

const GROUPS = {
  posts: { description: 'Blog posts', tools: ['listPosts', 'publishPost'] },
  org: { description: 'The organisation', tools: ['transferOrg'] },
} as const;

const whoami: AnyMcpTool = {
  name: 'whoami',
  description: 'Who the caller is',
  inputSchema: NO_ARGS,
  destructive: false,
  handle: async (_args, c) => jsonResult({ id: c.actor.id }),
};

const appServer = (): McpServer =>
  defineAppMcp({
    include: 'exposed',
    tools: [whoami],
    scopes: { 'posts:write': ['publishPost'] },
    surface: bySurface,
    groups: GROUPS,
  }).server;

describe('meta surface — refusals first', () => {
  test('a hidden resource is absent from list_resources, and manage_resource answers what an absent pair answers', async () => {
    const server = appServer();
    const listed = resultJson(await server.handle(call('list_resources'), metaMember()));
    expect((listed['resources'] as { name: string }[]).map((r) => r.name)).toEqual(['posts']);

    const hidden = await server.handle(manage('org', 'transferOrg'), metaMember());
    const absent = await server.handle(manage('org', 'noSuchTool'), metaMember());
    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(hidden).replace('transferOrg', 'noSuchTool')).toBe(
      JSON.stringify(absent),
    );
    expect(Object.keys(hidden?.error ?? {}).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(hidden)).not.toContain('FORBIDDEN');
  });

  test('describe_resource on a hidden resource answers what an unknown one answers', async () => {
    const server = appServer();
    const hidden = await server.handle(
      call('describe_resource', { resources: ['org'] }),
      metaMember(),
    );
    const absent = await server.handle(
      call('describe_resource', { resources: ['zzz'] }),
      metaMember(),
    );
    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(hidden).replace("'org'", "'zzz'").replace('org', 'zzz')).toBe(
      JSON.stringify(absent),
    );
  });

  test('a tool addressed under the WRONG resource is not found', async () => {
    const response = await appServer().handle(manage('org', 'publishPost'), metaOwner());
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a meta caller cannot reach a grouped tool by its flat name — and a flat caller never sees the meta tools', async () => {
    const server = appServer();
    const direct = await server.handle(call('publishPost', { postId: 'p' }), metaOwner());
    const absent = await server.handle(call('noSuchTool'), metaOwner());
    expect(direct?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(direct).replace('publishPost', 'noSuchTool')).toBe(
      JSON.stringify(absent),
    );
    const flat = await server.handle(call('list_resources'), flatOwner());
    expect(flat?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a list filter outside the whitelist is refused before the query runs', async () => {
    const server = appServer();
    const response = await inRequest(() =>
      server.handle(manage('posts', 'listPosts', { status_in: ['draft'] }), metaOwner()),
    );
    expect(response?.error?.code).toBe(INVALID_PARAMS);
    expect(JSON.stringify(response)).toContain('status_in');
    const badSort = await inRequest(() =>
      server.handle(manage('posts', 'listPosts', { sort: 'title' }), metaOwner()),
    );
    expect(badSort?.error?.code).toBe(INVALID_PARAMS);
  });

  test('malformed manage_resource arguments are invalid-args, not a crash', async () => {
    const response = await appServer().handle(
      call('manage_resource', { resource: 1 }),
      metaOwner(),
    );
    expect(response?.error?.code).toBe(INVALID_PARAMS);
  });

  test('boot refuses what would ship a silently wrong catalog', () => {
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: { x: { description: '', tools: ['nope'] } },
      }),
    ).toThrow('X_MCP_GROUP_UNKNOWN');
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: {
          a: { description: '', tools: ['publishPost'] },
          b: { description: '', tools: ['publishPost'] },
        },
      }),
    ).toThrow('X_MCP_GROUP_CONFLICT');
    expect(() => defineAppMcp({ include: 'exposed', surface: 'meta' })).toThrow(
      'X_MCP_SURFACE_INVALID',
    );
    expect(() => defineAppMcp({ include: 'exposed', groups: GROUPS })).toThrow(
      'X_MCP_SURFACE_INVALID',
    );
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: GROUPS,
        tools: [{ ...whoami, name: 'list_resources' }],
      }),
    ).toThrow('X_MCP_TOOL_DUPLICATE');
  });

  test('a listParams key the query input does not declare is refused at boot', () => {
    const tool: AnyMcpTool = {
      ...whoami,
      name: 'listThings',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
      listParams: { filters: { status: ['_eq'] } },
    };
    expect(() => createMcpServer({ tools: [tool] })).toThrow('X_MCP_LIST_PARAMS_INVALID');
  });

  test('a surface function that throws serves the flat surface', async () => {
    const server = defineAppMcp({
      include: 'exposed',
      surface: () => {
        throw new TypeError('boom');
      },
      groups: GROUPS,
    }).server;
    expect(listedNames(await server.handle(list, flatOwner()))).toContain('publishPost');
  });
});

describe('meta surface — the constant catalog', () => {
  test('the default is flat and unchanged', async () => {
    const plain = defineAppMcp({ include: 'exposed', tools: [whoami] }).server;
    expect(listedNames(await plain.handle(list, metaOwner()))).toEqual([
      'listPosts',
      'publishPost',
      'transferOrg',
      'whoami',
    ]);
  });

  test('tools/list is the same size however many primitives are grouped', async () => {
    const small = appServer();
    for (let i = 0; i < 30; i += 1) {
      registerAction(
        `extra${i}`,
        action({
          input: t.object({}),
          output: t.object({}),
          policy: can('post:read'),
          mcp: { expose: true },
          handle: () => ({}),
        }),
      );
    }
    const extras = Array.from({ length: 30 }, (_, i) => `extra${i}`);
    const large = defineAppMcp({
      include: 'exposed',
      tools: [whoami],
      surface: bySurface,
      groups: { ...GROUPS, extras: { description: 'Many', tools: extras } },
    }).server;

    const expected = ['describe_resource', 'list_resources', 'manage_resource', 'whoami'];
    expect(listedNames(await small.handle(list, metaOwner()))).toEqual(expected);
    expect(listedNames(await large.handle(list, metaOwner()))).toEqual(expected);
    // The flat population on the same server still gets one tool per primitive.
    expect(listedNames(await large.handle(list, flatOwner())).length).toBe(34);
  });

  test('list_resources carries kind, a one-line param hint, scope and the confirmation hint', async () => {
    const tools = [
      ...defineAppMcp({ include: 'exposed' }).tools.map((tool) =>
        tool.name === 'publishPost' ? { ...tool, confirms: true } : tool,
      ),
    ];
    const server = createMcpServer({
      tools,
      surface: 'meta',
      groups: GROUPS,
    });
    const listed = resultJson(await server.handle(call('list_resources'), metaOwner()));
    expect(listed['resources']).toEqual([
      {
        name: 'org',
        description: 'The organisation',
        actions: [
          { name: 'transferOrg', kind: 'action', description: 'Transfer the org', params: '' },
        ],
      },
      {
        name: 'posts',
        description: 'Blog posts',
        actions: [
          {
            name: 'listPosts',
            kind: 'query',
            description: 'Posts, filtered',
            params:
              'status_eq?: string|number|boolean, title_cont?: string, sort?: "createdAt"|"-createdAt", cursor?: string, limit?: integer',
          },
          {
            name: 'publishPost',
            kind: 'action',
            description: 'Publish a draft post',
            params: 'postId: string',
            confirms: true,
          },
        ],
      },
    ]);
  });

  test('describe_resource is batched and returns the full schemas', async () => {
    const response = await appServer().handle(
      call('describe_resource', { resources: ['posts', 'org', 'posts'] }),
      metaOwner(),
    );
    const described = resultJson(response)['resources'] as {
      name: string;
      actions: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    }[];
    expect(described.map((r) => r.name)).toEqual(['posts', 'org']);
    const listPosts = described[0]?.actions.find((a) => a.name === 'listPosts');
    expect(Object.keys(listPosts?.inputSchema.properties ?? {})).toEqual([
      'status_eq',
      'title_cont',
      'sort',
      'cursor',
      'limit',
    ]);
  });

  test('oneLineParams cuts a long hint and points at describe_resource', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, { type: 'string' as const }]),
    );
    const hint = oneLineParams({ type: 'object', properties });
    expect(hint.length).toBeLessThan(300);
    expect(hint).toContain('describe_resource');
  });
});

describe('meta surface — manage_resource is the flat call, through another door', () => {
  /** The same response, whichever surface asked. */
  const parity = async (
    flatCall: ReturnType<typeof call>,
    metaCall: ReturnType<typeof call>,
    flatCaller: McpCaller,
    metaCaller: McpCaller,
  ) => {
    const server = appServer();
    const viaFlat = await inRequest(() => server.handle(flatCall, flatCaller));
    const viaMeta = await inRequest(() => server.handle(metaCall, metaCaller));
    expect(JSON.stringify(viaMeta)).toBe(JSON.stringify(viaFlat));
    return viaMeta;
  };

  test('scope refusal is identical, and the policy never ran', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatOwner(),
      metaOwner(),
    );
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(published).toBe(0);
  });

  test('policy refusal is identical', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatMember(['posts:write']),
      metaMember(['posts:write']),
    );
    expect(JSON.stringify(response)).toContain('X_FORBIDDEN');
    expect(published).toBe(0);
  });

  test('an awaiting-confirmation write answers identically and runs once per call', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatOwner(['posts:write']),
      metaOwner(['posts:write']),
    );
    expect(resultJson(response)).toEqual({ ok: true, status: 'awaiting_confirmation' });
    expect(published).toBe(2);
  });

  test('a list query with whitelisted params answers what the flat call answers', async () => {
    const response = await parity(
      call('listPosts', { status_eq: 'draft', sort: '-createdAt', limit: 5 }),
      manage('posts', 'listPosts', { status_eq: 'draft', sort: '-createdAt', limit: 5 }),
      flatOwner(),
      metaOwner(),
    );
    expect(resultJson(response)).toEqual([{ id: 'p1' }, { id: 'p2' }] as never);
  });

  test('invalid tool arguments are identical', async () => {
    await parity(
      call('publishPost', {}),
      manage('posts', 'publishPost', {}),
      flatOwner(['posts:write']),
      metaOwner(['posts:write']),
    );
  });

  test('manage_resource is metered as the tool it reaches', () => {
    const server = appServer();
    expect(server.classify(manage('posts', 'listPosts'))).toBe('read');
    expect(server.classify(manage('posts', 'publishPost'))).toBe('write');
    expect(server.classify(call('manage_resource', {}))).toBe('write');
    expect(server.classify(call('list_resources'))).toBe('read');
  });
});
