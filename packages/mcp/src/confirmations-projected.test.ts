// The declaration half of the confirmation gate (`CLAUDE.md`: a gate needs a test over what an app
// actually declares): a REAL action, projected by `defineAppMcp({ actions })`, gated by name. An
// approval is a precondition, never a permission — the action's own policy still decides the call
// it lets through, and its handler sees the arguments the person approved.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import {
  agentActor,
  ctxOf,
  generateMasterKey,
  runWithContext,
  SECRETS_KEY_ENV,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';
import type { McpCaller } from './registry';

afterEach(() => resetActions());

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);
const human = userActor({ id: 'u-1', orgId: 'o1', permissions: ['order:confirm'] });

function app() {
  const refunded: string[] = [];
  const refundOrder = action({
    input: t.object({ orderId: t.string }),
    output: t.object({ ok: t.boolean }),
    policy: can<{ orderId: string }>('order:refund', ({ input }) => input.orderId !== 'locked'),
    mcp: { expose: true, description: 'Refund one order' },
    handle: ({ input }) => {
      refunded.push(input.orderId);
      return { ok: true };
    },
  });
  registerAction('refundOrder', refundOrder);
  const confirmRefunds = mcpConfirmations({
    tools: ['refundOrder'],
    store: memoryConfirmationStore(),
    permission: 'order:confirm',
    sealKeys: {
      root: '/nonexistent/mcp-projected',
      env: { [SECRETS_KEY_ENV]: generateMasterKey() },
    },
  });
  registerAction('confirmRefunds', confirmRefunds);
  const mcp = defineAppMcp({
    actions: [refundOrder],
    confirmations: confirmRefunds,
    errorAudience: 'developer',
  });
  const call = async (caller: McpCaller, orderId: string): Promise<string> => {
    const response = await inRequest(() =>
      mcp.server.handle(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'refundOrder', arguments: { orderId } },
        },
        caller,
      ),
    );
    const result = response?.result as { content: { text: string }[] } | undefined;
    return result?.content[0]?.text ?? JSON.stringify(response);
  };
  const approve = async (text: string) => {
    const id = /confirmation ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
    const shown = await confirmRefunds.as(human, { id, decision: 'view' });
    return confirmRefunds.as(human, { id, decision: 'approve', arguments: shown.arguments ?? {} });
  };
  return { call, approve, refunded };
}

const permitted: McpCaller = {
  actor: agentActor({ id: 'agent-1', orgId: 'o1', permissions: ['order:refund'] }),
  scopes: new Set(),
};

describe('a projected action behind the confirmation gate', () => {
  test('waits, is approved, then runs through its own invoke with the approved input', async () => {
    const { call, approve, refunded } = app();
    const pending = await call(permitted, 'o-7');
    expect(pending).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
    await approve(pending);
    expect(await call(permitted, 'o-7')).toBe('{"ok":true}');
    expect(refunded).toEqual(['o-7']);
  });

  test("an approval never overrides the action's policy: the approved call is still denied", async () => {
    const { call, approve, refunded } = app();
    await approve(await call(permitted, 'locked'));
    expect(await call(permitted, 'locked')).toContain('X_FORBIDDEN');
    expect(refunded).toEqual([]);
  });

  test('a caller the policy refuses outright opens no confirmation at all', async () => {
    const { call } = app();
    const unpermitted: McpCaller = { actor: agentActor({ id: 'agent-2' }), scopes: new Set() };
    const answer = await call(unpermitted, 'o-7');
    expect(answer).toContain('X_FORBIDDEN');
    expect(answer).not.toContain('X_MCP_CONFIRMATION');
  });
});

describe('two servers, two deciders, one tool', () => {
  test('each server opens its rows in its own store, in the MCP order', async () => {
    const refundOrder = action({
      input: t.object({ orderId: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('order:refund'),
      mcp: { expose: true },
      handle: () => ({ ok: true }),
    });
    registerAction('refundOrder', refundOrder);
    const keys = {
      root: '/nonexistent/mcp-projected',
      env: { [SECRETS_KEY_ENV]: generateMasterKey() },
    };
    const server = (store: ReturnType<typeof memoryConfirmationStore>, name: string) => {
      const confirmations = registerAction(
        name,
        mcpConfirmations({
          tools: ['refundOrder'],
          store,
          permission: 'order:confirm',
          sealKeys: keys,
        }),
      );
      return defineAppMcp({
        actions: [refundOrder],
        confirmations,
        errorAudience: 'developer',
      }).server;
    };
    const firstStore = memoryConfirmationStore();
    const secondStore = memoryConfirmationStore();
    const ask = async (mcp: ReturnType<typeof server>) => {
      const response = await inRequest(() =>
        mcp.handle(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'refundOrder', arguments: { orderId: 'o-1' } },
          },
          permitted,
        ),
      );
      return /confirmation ([0-9a-f-]{36})/.exec(JSON.stringify(response))?.[1] ?? '';
    };
    const atSecond = await ask(server(secondStore, 'secondDecider'));
    const atFirst = await ask(server(firstStore, 'firstDecider'));
    expect(await secondStore.get(atSecond)).toBeDefined();
    expect(await firstStore.get(atSecond)).toBeUndefined();
    expect(await firstStore.get(atFirst)).toBeDefined();
    expect(await secondStore.get(atFirst)).toBeUndefined();
  });
});

describe('a server handed no `confirmations` still meets the registered gate', () => {
  function refund() {
    const refunded: string[] = [];
    const refundOrder = action({
      input: t.object({ orderId: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('order:refund'),
      mcp: { expose: true },
      handle: ({ input }) => {
        refunded.push(input.orderId);
        return { ok: true };
      },
    });
    registerAction('refundOrder', refundOrder);
    return { refundOrder, refunded };
  }
  const gateOn = (tools: readonly string[]) =>
    mcpConfirmations({
      tools,
      store: memoryConfirmationStore(),
      permission: 'order:confirm',
      sealKeys: {
        root: '/nonexistent/mcp-projected',
        env: { [SECRETS_KEY_ENV]: generateMasterKey() },
      },
    });
  const ask = async (server: ReturnType<typeof defineAppMcp>['server'], name: string) =>
    JSON.stringify(
      await inRequest(() =>
        server.handle(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: { orderId: 'B-mcp' } },
          },
          permitted,
        ),
      ),
    );

  test('forgetting the option is no bypass: the same tool waits, and nothing ran', async () => {
    const { refundOrder, refunded } = refund();
    gateOn(['refundOrder']);
    const { server, tools } = defineAppMcp({ actions: [refundOrder], errorAudience: 'developer' });
    expect(await ask(server, 'refundOrder')).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
    expect(tools.find((tool) => tool.name === 'refundOrder')?.confirms).toBe(true);
  });

  test('read at call time: a gate declared after the server still holds the tool', async () => {
    const { refundOrder, refunded } = refund();
    const { server } = defineAppMcp({ actions: [refundOrder], errorAudience: 'developer' });
    gateOn(['refundOrder']);
    expect(await ask(server, 'refundOrder')).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
  });

  test('a server with its own gate on another tool still consults the registry for this one', async () => {
    const { refundOrder, refunded } = refund();
    const voidOrder = action({
      input: t.object({ orderId: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('order:refund'),
      mcp: { expose: true },
      handle: () => ({ ok: true }),
    });
    registerAction('voidOrder', voidOrder);
    gateOn(['refundOrder']);
    const { server } = defineAppMcp({
      actions: [refundOrder, voidOrder],
      confirmations: gateOn(['voidOrder']),
      errorAudience: 'developer',
    });
    expect(await ask(server, 'refundOrder')).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
  });

  test('a caller the policy refuses outright opens no row here either', async () => {
    const { refundOrder } = refund();
    gateOn(['refundOrder']);
    const { server } = defineAppMcp({ actions: [refundOrder], errorAudience: 'developer' });
    const stranger: McpCaller = { actor: agentActor({ id: 'agent-2' }), scopes: new Set() };
    const answer = JSON.stringify(
      await inRequest(() =>
        server.handle(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'refundOrder', arguments: { orderId: 'B-mcp' } },
          },
          stranger,
        ),
      ),
    );
    expect(answer).toContain('X_FORBIDDEN');
    expect(answer).not.toContain('X_MCP_CONFIRMATION');
  });

  test('an ungated tool runs', async () => {
    const { refundOrder, refunded } = refund();
    const { server, tools } = defineAppMcp({ actions: [refundOrder], errorAudience: 'developer' });
    expect(await ask(server, 'refundOrder')).toContain('ok');
    expect(refunded).toEqual(['B-mcp']);
    expect(tools.find((tool) => tool.name === 'refundOrder')?.confirms).toBeUndefined();
  });
});
