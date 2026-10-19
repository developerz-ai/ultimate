// The `'meta-split'` surface — `read_resource` / `write_resource` / `delete_resource` picked from a
// declared effect — as a real app declares it. Failure cases first: boot refusals, the wrong
// dispatcher, an unconfirmed commit and a preview that must not run; then the success path, which
// must answer byte for byte what the flat `tools/call` answers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetActions } from '@ultimat3/action';
import type { McpEffect } from '@ultimat3/core';
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
import type { McpAuditEvent } from './audit-hook';
import type { McpCaller } from './registry';
import type { McpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { METHOD_NOT_FOUND } from './wire';

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const text = (response: JsonRpcResponse | null): string =>
  (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text ?? '';
const isError = (response: JsonRpcResponse | null): boolean =>
  (response?.result as { isError?: boolean } | undefined)?.isError === true;
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

const owner = agentActor({ id: 'agent-owner', orgId: 'o1', roles: ['owner'] });
const member = agentActor({ id: 'agent-member', orgId: 'o1', roles: ['member'] });
const as = (actor: typeof owner, surface: 'split' | 'flat'): McpCaller => ({
  actor,
  role: `${surface}:${actor.roles?.[0] ?? ''}`,
  scopes: new Set(),
});
const splitOwner = as(owner, 'split');
const flatOwner = as(owner, 'flat');
const splitMember = as(member, 'split');

let ran: Record<string, number> = {};
let lastInput: unknown;

const register = (effects: { archive?: McpEffect; rename?: McpEffect } = {}) => {
  registerAction(
    'renamePost',
    action({
      input: t.object({ postId: t.string, title: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('post:write'),
      mcp: {
        expose: true,
        description: 'Rename a post',
        ...(effects.rename === undefined ? {} : { effect: effects.rename }),
      },
      handle: () => {
        ran['renamePost'] = (ran['renamePost'] ?? 0) + 1;
        return { ok: true };
      },
    }),
  );
  registerAction(
    'archivePost',
    action({
      input: t.object({ postId: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('post:archive'),
      mcp: {
        expose: true,
        description: 'Archive a post',
        ...(effects.archive === undefined ? {} : { effect: effects.archive }),
      },
      handle: ({ input }) => {
        lastInput = input;
        ran['archivePost'] = (ran['archivePost'] ?? 0) + 1;
        return { ok: true };
      },
    }),
  );
  registerAction(
    'boostPost',
    action({
      input: t.object({ postId: t.string, live: t.optional(t.boolean) }),
      output: t.object({ ok: t.boolean, charged: t.boolean }),
      policy: can('post:archive'),
      mcp: { expose: true, description: 'Boost a post (spends money)', effect: 'delete' },
      handle: ({ input }) => {
        ran['boostPost'] = (ran['boostPost'] ?? 0) + 1;
        return { ok: true, charged: input.live === true };
      },
    }),
  );
  registerQuery(
    'listPosts',
    query({
      input: t.object({}),
      policy: can('post:read'),
      mcp: { expose: true, description: 'Posts' },
      sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
    }),
  );
};

beforeEach(() => {
  ran = {};
  lastInput = undefined;
  definePermissions(['post:read', 'post:write', 'post:archive']);
  defineRoles({
    owner: { grants: ['post:read', 'post:write', 'post:archive'] },
    member: { grants: ['post:read'] },
  });
});

afterEach(() => {
  resetActions();
  resetQueries();
  clearPermissions();
  clearRoles();
});

const GROUPS = {
  posts: {
    description: 'Blog posts',
    tools: ['listPosts', 'renamePost', 'archivePost', 'boostPost'],
  },
} as const;

let audits: McpAuditEvent[] = [];
const appServer = (surface: 'meta-split' | ((c: McpCaller) => 'meta-split' | 'flat')): McpServer =>
  defineAppMcp({
    include: 'exposed',
    surface,
    groups: GROUPS,
    onAudit: (event) => {
      audits.push(event);
    },
  }).server;
const splitServer = () => {
  register({ rename: 'write', archive: 'delete' });
  audits = [];
  return appServer((c) => (c.role?.startsWith('split:') === true ? 'meta-split' : 'flat'));
};

describe('meta-split — boot refusals', () => {
  test('a grouped write without an effect is X_MCP_EFFECT_UNDECLARED, naming every one', () => {
    register({ rename: 'write' });
    expect(() => appServer('meta-split')).toThrow(
      expect.objectContaining({ code: 'X_MCP_EFFECT_UNDECLARED', names: ['archivePost'] }),
    );
  });

  test('a query declaring an effect is X_MCP_EFFECT_CONFLICT', () => {
    register({ rename: 'write', archive: 'delete' });
    registerQuery(
      'countPosts',
      query({
        input: t.object({}),
        policy: can('post:read'),
        mcp: { expose: true, description: 'Count', effect: 'write' },
        sql: () => from<{ id: string }>('posts', []),
      }),
    );
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta-split',
        groups: { posts: { description: 'p', tools: ['countPosts', 'renamePost'] } },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_MCP_EFFECT_CONFLICT' }));
  });

  test("a surface function in an app that declares no effect serves 'meta', never an unchecked split", async () => {
    register();
    const { server } = defineAppMcp({
      include: 'exposed',
      surface: () => 'meta-split',
      groups: { posts: { description: 'p', tools: ['listPosts', 'renamePost', 'archivePost'] } },
    });
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, splitOwner);
    const names = ((listed?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map(
      (x) => x.name,
    );
    expect(names).toContain('manage_resource');
    expect(names).not.toContain('delete_resource');
  });
});

describe('meta-split — refusals', () => {
  test('the wrong dispatcher is X_MCP_WRONG_TOOL naming the right one, and nothing runs', async () => {
    const server = splitServer();
    const viaWrite = await inRequest(() =>
      server.handle(
        call('write_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1' },
        }),
        splitOwner,
      ),
    );
    expect(isError(viaWrite)).toBe(true);
    expect(text(viaWrite)).toStartWith('X_MCP_WRONG_TOOL: ');
    expect(text(viaWrite)).toContain('it is run by delete_resource');
    const viaRead = await inRequest(() =>
      server.handle(
        call('read_resource', {
          resource: 'posts',
          action: 'renamePost',
          params: { postId: 'p1', title: 'x' },
        }),
        splitOwner,
      ),
    );
    expect(text(viaRead)).toContain('it is run by write_resource');
    const queryViaDelete = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'listPosts',
          confirmed_by_user: true,
          live: true,
        }),
        splitOwner,
      ),
    );
    expect(text(queryViaDelete)).toContain('it is run by read_resource');
    expect(ran).toEqual({});
    expect(audits.at(-1)).toMatchObject({ tool: 'listPosts', outcome: 'invalid-args' });
  });

  test('a live delete without confirmed_by_user: true runs nothing', async () => {
    const server = splitServer();
    for (const confirmed of [false, 'yes']) {
      const answer = await inRequest(() =>
        server.handle(
          call('delete_resource', {
            resource: 'posts',
            action: 'archivePost',
            params: { postId: 'p1' },
            live: true,
            confirmed_by_user: confirmed,
          }),
          splitOwner,
        ),
      );
      expect(isError(answer)).toBe(true);
    }
    const unconfirmed = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1', live: true, confirmed_by_user: false },
          confirmed_by_user: false,
        }),
        splitOwner,
      ),
    );
    expect(text(unconfirmed)).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
    expect(ran).toEqual({});
    expect(audits.at(-1)).toMatchObject({ tool: 'archivePost', outcome: 'unconfirmed' });
  });

  test('a live call with no confirmed_by_user anywhere runs nothing', async () => {
    const server = splitServer();
    const answer = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1' },
          live: true,
        }),
        splitOwner,
      ),
    );
    expect(text(answer)).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
    expect(ran).toEqual({});
  });

  test('a preview without live runs nothing and is audited previewed', async () => {
    const server = splitServer();
    const answer = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1' },
          confirmed_by_user: false,
        }),
        splitOwner,
      ),
    );
    expect(isError(answer)).toBe(false);
    expect(JSON.parse(text(answer))).toEqual({
      preview: true,
      ran: false,
      resource: 'posts',
      action: 'archivePost',
      params: { postId: 'p1' },
      commit_with: { live: true, confirmed_by_user: true },
    });
    expect(ran).toEqual({});
    expect(audits.at(-1)).toMatchObject({ tool: 'archivePost', outcome: 'previewed' });
  });

  test('a caller the policy refuses gets the denial, never a preview', async () => {
    const server = splitServer();
    const answer = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1' },
          confirmed_by_user: true,
        }),
        splitMember,
      ),
    );
    expect(text(answer)).toStartWith('X_FORBIDDEN');
    expect(ran).toEqual({});
  });

  test('an unknown pair on any dispatcher is the absent answer', async () => {
    const server = splitServer();
    const answer = await inRequest(() =>
      server.handle(call('read_resource', { resource: 'posts', action: 'nope' }), splitOwner),
    );
    expect(answer?.error?.code).toBe(METHOD_NOT_FOUND);
    const manage = await inRequest(() =>
      server.handle(
        call('manage_resource', { resource: 'posts', action: 'listPosts' }),
        splitOwner,
      ),
    );
    expect(manage?.error?.code).toBe(METHOD_NOT_FOUND);
  });
});

describe('meta-split — the catalog', () => {
  test('tools/list is the catalog pair and three honest dispatchers', async () => {
    const server = splitServer();
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, splitOwner);
    const tools = (
      (listed?.result ?? { tools: [] }) as {
        tools: {
          name: string;
          annotations?: Record<string, boolean>;
          inputSchema: { required?: string[] };
        }[];
      }
    ).tools;
    expect(tools.map((x) => x.name)).toEqual([
      'delete_resource',
      'describe_resource',
      'list_resources',
      'read_resource',
      'write_resource',
    ]);
    const byName = new Map(tools.map((x) => [x.name, x]));
    expect(byName.get('read_resource')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('write_resource')?.annotations).toMatchObject({ readOnlyHint: false });
    expect(byName.get('delete_resource')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // The flags may ride inside `params`, so the schema requires neither (#798).
    expect(byName.get('delete_resource')?.inputSchema.required).toEqual(['resource', 'action']);
  });

  test('list_resources tags each write with the dispatcher that runs it', async () => {
    const server = splitServer();
    const answer = await inRequest(() => server.handle(call('list_resources'), splitOwner));
    const lines = text(answer).split('\n');
    expect(lines[0]).toContain('read_resource');
    expect(lines).toContain('  archivePost (delete) {postId: string} — Archive a post');
    expect(lines).toContain('  renamePost (write) {postId: string, title: string} — Rename a post');
    expect(lines).toContain('  listPosts {} — Posts');
  });
});

describe('meta-split — the flat call through another door', () => {
  test('read_resource and write_resource answer what the flat call answers', async () => {
    const server = splitServer();
    const read = await inRequest(() =>
      server.handle(call('read_resource', { resource: 'posts', action: 'listPosts' }), splitOwner),
    );
    const flatRead = await inRequest(() => server.handle(call('listPosts'), flatOwner));
    expect(isError(read)).toBe(false);
    expect(text(read)).toContain('p1');
    expect(read?.result).toEqual(flatRead?.result);
    const args = { postId: 'p1', title: 'x' };
    const write = await inRequest(() =>
      server.handle(
        call('write_resource', { resource: 'posts', action: 'renamePost', params: args }),
        splitOwner,
      ),
    );
    const flatWrite = await inRequest(() => server.handle(call('renamePost', args), flatOwner));
    expect(write?.result).toEqual(flatWrite?.result);
    expect(ran['renamePost']).toBe(2);
  });

  test('a live, confirmed delete runs once and never hands the action the dispatcher flags', async () => {
    const server = splitServer();
    const answer = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'archivePost',
          params: { postId: 'p1', confirmed_by_user: true, live: true },
          confirmed_by_user: false,
        }),
        splitOwner,
      ),
    );
    expect(isError(answer)).toBe(false);
    expect(ran['archivePost']).toBe(1);
    expect(lastInput).toEqual({ postId: 'p1' });
    expect(audits.at(-1)).toMatchObject({ tool: 'archivePost', outcome: 'ok' });
  });

  test('an action that declares live authors its own preview: handed live: false, then true', async () => {
    const server = splitServer();
    const preview = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'boostPost',
          params: { postId: 'p1' },
          confirmed_by_user: false,
        }),
        splitOwner,
      ),
    );
    expect(JSON.parse(text(preview))).toEqual({ ok: true, charged: false });
    const commit = await inRequest(() =>
      server.handle(
        call('delete_resource', {
          resource: 'posts',
          action: 'boostPost',
          params: { postId: 'p1' },
          live: true,
          confirmed_by_user: true,
        }),
        splitOwner,
      ),
    );
    expect(JSON.parse(text(commit))).toEqual({ ok: true, charged: true });
  });

  test('each dispatcher is metered as the action it reaches', () => {
    const server = splitServer();
    const meter = (name: string, act: string) =>
      server.classify(call(name, { resource: 'posts', action: act }));
    expect(meter('read_resource', 'listPosts')).toBe('read');
    expect(meter('write_resource', 'renamePost')).toBe('write');
    expect(meter('delete_resource', 'archivePost')).toBe('write');
  });
});
