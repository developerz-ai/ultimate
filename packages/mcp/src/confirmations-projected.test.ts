// The declaration half of the confirmation gate (`CLAUDE.md`: a gate needs a test over what an app
// actually declares): a REAL action, projected by `defineAppMcp({ actions })`, gated by name. An
// approval is a precondition, never a permission — the action's own policy still decides the call
// it lets through, and its handler sees the arguments the person approved.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetActions } from '@ultimat3/action';
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
