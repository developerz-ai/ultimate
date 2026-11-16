// The META-surface app the meta-surface tests share: two actions, a query, the roles and the
// `surface`/`groups` switch an app writes, plus the JSON-RPC helpers that read its answers.
// Split out of meta-surface.test.ts so its three describes can live in two files.

import { afterEach, beforeEach } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, resetQueries } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { AnyMcpTool, McpCaller } from './registry';
import { jsonResult } from './registry';
import type { McpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { NO_ARGS } from './wire';

export const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
export const manage = (resource: string, act: string, params?: Record<string, unknown>) =>
  call('manage_resource', {
    resource,
    action: act,
    ...(params === undefined ? {} : { params }),
  });
export const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };

export const listedNames = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );
export const resultJson = (response: JsonRpcResponse | null): Record<string, unknown> => {
  const text = (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]
    ?.text;
  return JSON.parse(text ?? 'null') as Record<string, unknown>;
};

export const resultText = (response: JsonRpcResponse | null): string =>
  (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text ?? '';
/** An argument refusal: a tool result the model reads, `X_INPUT_INVALID`, since 22.10. */
export const refusedArgs = (response: JsonRpcResponse | null): boolean =>
  response?.error === undefined &&
  (response?.result as { isError?: boolean } | undefined)?.isError === true &&
  resultText(response).startsWith('X_INPUT_INVALID: ');

export const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

export const owner = agentActor({ id: 'agent-owner', orgId: 'o1', roles: ['owner'] });
export const member = agentActor({ id: 'agent-member', orgId: 'o1', roles: ['member'] });

/** `staff` → meta; everyone else flat. The population switch the app writes. */
export const caller = (
  actor: typeof owner,
  role: string,
  scopes: readonly string[] = [],
  surface: 'meta' | 'flat' = 'meta',
): McpCaller => ({
  actor,
  role: `${surface}:${role}`,
  // `app:use` is the base capability every tool not under `posts:write` sits behind: a scoped
  // server must cover every tool (`X_MCP_SCOPE_UNCOVERED`), so the token that reaches them holds it.
  scopes: new Set(['app:use', ...scopes]),
});
export const metaOwner = (scopes: readonly string[] = []) => caller(owner, 'owner', scopes);
export const metaMember = (scopes: readonly string[] = []) => caller(member, 'member', scopes);
export const flatOwner = (scopes: readonly string[] = []) => caller(owner, 'owner', scopes, 'flat');
export const flatMember = (scopes: readonly string[] = []) =>
  caller(member, 'member', scopes, 'flat');

export const bySurface = (c: McpCaller): 'meta' | 'flat' =>
  c.role?.startsWith('meta:') === true ? 'meta' : 'flat';
export const ownerRoles = ['meta:owner', 'flat:owner'];

let published = 0;

/** How many times `publishPost` ran since the last reset. */
export const publishedCount = (): number => published;

/** The app every meta-surface test runs against, registered before and torn down after each. */
export function useMetaSurfaceApp(): void {
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
}

export const GROUPS = {
  posts: { description: 'Blog posts', tools: ['listPosts', 'publishPost'] },
  org: { description: 'The organisation', tools: ['transferOrg'] },
} as const;

export const whoami: AnyMcpTool = {
  name: 'whoami',
  description: 'Who the caller is',
  inputSchema: NO_ARGS,
  destructive: false,
  handle: async (_args, c) => jsonResult({ id: c.actor.id }),
};

export const appServer = (): McpServer =>
  defineAppMcp({
    include: 'exposed',
    tools: [whoami],
    scopes: { 'posts:write': ['publishPost'], 'app:use': ['listPosts', 'transferOrg', 'whoami'] },
    surface: bySurface,
    groups: GROUPS,
  }).server;
