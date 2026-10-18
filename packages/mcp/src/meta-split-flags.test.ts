// `delete_resource`'s two dispatcher flags, read top-level or nested in `params`: nested ALWAYS
// wins — for an action that declares the same field in its own input too — so a nested refusal
// beside a top-level approval is a refusal, and nothing runs.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { action, registerAction, resetActions } from '@ultimat3/action';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import type { JsonRpcResponse } from './wire';

const owner: McpCaller = {
  actor: agentActor({ id: 'agent-owner', orgId: 'o1', roles: ['owner'] }),
  scopes: new Set(),
};
const text = (response: JsonRpcResponse | null): string =>
  (response?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text ?? '';

let ran = 0;

beforeEach(() => {
  ran = 0;
  definePermissions(['post:archive']);
  defineRoles({ owner: { grants: ['post:archive'] } });
  // Two actions: one that leaves the flags to the dispatcher, one that declares them as its own.
  for (const [name, input] of [
    ['archivePost', t.object({ postId: t.string })],
    ['purgePost', t.object({ postId: t.string, confirmed_by_user: t.optional(t.boolean) })],
  ] as const) {
    registerAction(
      name,
      action({
        input,
        output: t.object({ ok: t.boolean }),
        policy: can('post:archive'),
        mcp: { expose: true, description: name, effect: 'delete' },
        handle: () => {
          ran += 1;
          return { ok: true };
        },
      }),
    );
  }
});

afterEach(() => {
  resetActions();
  clearPermissions();
  clearRoles();
});

const commit = async (act: string): Promise<JsonRpcResponse | null> => {
  const { server } = defineAppMcp({
    include: 'exposed',
    surface: 'meta-split',
    groups: { posts: { description: 'Posts', tools: ['archivePost', 'purgePost'] } },
  });
  return await runWithContext(ctxOf({}), () =>
    server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'delete_resource',
          arguments: {
            resource: 'posts',
            action: act,
            params: { postId: 'p1', confirmed_by_user: false },
            live: true,
            confirmed_by_user: true,
          },
        },
      },
      owner,
    ),
  );
};

test('a nested confirmed_by_user: false wins over a top-level true', async () => {
  expect(text(await commit('archivePost'))).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
  expect(ran).toBe(0);
});

test('nested wins for an action that declares confirmed_by_user in its own input too', async () => {
  expect(text(await commit('purgePost'))).toStartWith('X_MCP_USER_CONFIRMATION_REQUIRED: ');
  expect(ran).toBe(0);
});
