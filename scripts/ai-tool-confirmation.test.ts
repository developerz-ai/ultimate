// One `mcpConfirmations` list holds both tool surfaces. Host test for the reason its neighbour
// `ai-mcp-tool-parity.test.ts` is: `ai` and `mcp` are one tier, so neither may import the other, tests
// included, and this is the one place the real gate meets the real adapter.
//
// Reproduced before the fix: over `mcp.server.handle` X_MCP_CONFIRMATION_PENDING and nothing ran;
// through `asProjectableAction` + `runLlmToolCall` `{"ok":true}` and the refund ran.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, knownToolNames, registerAction, resetActions } from '@ultimat3/action';
import {
  agent,
  asProjectableAction,
  definePrompt,
  inProcessTool,
  runLlmToolCall,
} from '@ultimat3/ai';
import {
  ctxOf,
  generateMasterKey,
  runWithContext,
  SECRETS_KEY_ENV,
  userActor,
} from '@ultimat3/core';
import type { McpCaller } from '@ultimat3/mcp';
import { defineAppMcp, mcpConfirmations, memoryConfirmationStore } from '@ultimat3/mcp';
import { can, clearPermissions } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

// Another file's `definePermissions` must not decide whether `can('order:refund')` declares.
beforeEach(() => clearPermissions());
afterEach(() => resetActions());

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

const sealKeys = () => ({
  root: '/nonexistent/ai-tool-confirmation',
  env: { [SECRETS_KEY_ENV]: generateMasterKey() },
});

/** The in-app agent's actor: the user it runs for, which is why `kind === 'agent'` does not stop it. */
const member = userActor({ id: 'u-1', orgId: 'o1', permissions: ['order:refund'] });
const person = userActor({ id: 'u-2', orgId: 'o1', permissions: ['order:confirm'] });

function app() {
  const refunded: string[] = [];
  const refundOrder = action({
    input: t.object({ orderId: t.string, reason: t.string.default('asked') }),
    output: t.object({ ok: t.boolean }),
    policy: can('order:refund'),
    mcp: { expose: true, description: 'Refund one order' },
    handle: ({ input }) => {
      refunded.push(input.orderId);
      return { ok: true };
    },
  });
  registerAction('refundOrder', refundOrder);
  const store = memoryConfirmationStore();
  let opened = 0;
  const confirmRefunds = mcpConfirmations({
    tools: ['refundOrder'],
    store: {
      ...store,
      open: (draft) => {
        opened += 1;
        return store.open(draft);
      },
    },
    permission: 'order:confirm',
    sealKeys: sealKeys(),
  });
  registerAction('confirmRefunds', confirmRefunds);
  const tool = asProjectableAction(refundOrder);
  const inApp = async (input: Record<string, unknown>, actor = member): Promise<string> => {
    const result = await inRequest(() =>
      runLlmToolCall([tool], { id: 'c1', name: 'refundOrder', input }, actor),
    );
    return result.content;
  };
  const approve = async (text: string) => {
    const id = /confirmation ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';
    const shown = await inRequest(() => confirmRefunds.as(person, { id, decision: 'view' }));
    await inRequest(() =>
      confirmRefunds.as(person, { id, decision: 'approve', arguments: shown.arguments ?? {} }),
    );
    return shown;
  };
  return { refundOrder, confirmRefunds, inApp, approve, refunded, openedCount: () => opened };
}

describe('the reproduction: one list, both surfaces', () => {
  test('over MCP and in-app, the same actor kind and arguments both wait', async () => {
    const { refundOrder, confirmRefunds, inApp, refunded } = app();
    const mcp = defineAppMcp({
      actions: [refundOrder],
      confirmations: confirmRefunds,
      errorAudience: 'developer',
    });
    const caller: McpCaller = { actor: member, scopes: new Set() };
    const response = await inRequest(() =>
      mcp.server.handle(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'refundOrder', arguments: { orderId: 'A' } },
        },
        caller,
      ),
    );
    expect(JSON.stringify(response)).toContain('X_MCP_CONFIRMATION_PENDING');
    const inAppAnswer = await inApp({ orderId: 'B' });
    expect(inAppAnswer).toContain('X_MCP_CONFIRMATION_PENDING');
    // What a model can act on: the person to ask, never a decision action it is not offered.
    expect(inAppAnswer).toContain('ask a person who may approve it');
    expect(inAppAnswer).not.toContain('confirmations({');
    expect(refunded).toEqual([]);
  });
});

describe('in-app, an approval', () => {
  test('runs the repeat once; a second repeat opens a new row', async () => {
    const { inApp, approve, refunded } = app();
    const pending = await inApp({ orderId: 'B' });
    await approve(pending);
    expect(await inApp({ orderId: 'B' })).toBe('{"ok":true}');
    expect(refunded).toEqual(['B']);
    const again = await inApp({ orderId: 'B' });
    expect(again).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(again).not.toContain(/confirmation ([0-9a-f-]{36})/.exec(pending)?.[1] ?? 'absent');
    expect(refunded).toEqual(['B']);
  });

  test('is shown the arguments with their defaults, and a repeat omitting one consumes it', async () => {
    const { inApp, approve, refunded } = app();
    const shown = await approve(await inApp({ orderId: 'B', reason: 'asked' }));
    expect(shown.arguments).toEqual({ orderId: 'B', reason: 'asked' });
    expect(await inApp({ orderId: 'B' })).toBe('{"ok":true}');
    expect(refunded).toEqual(['B']);
  });

  test('binds the arguments: other arguments ride no approval', async () => {
    const { inApp, approve, refunded } = app();
    await approve(await inApp({ orderId: 'B' }));
    expect(await inApp({ orderId: 'C' })).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
  });

  test('binds the actor: another member rides no approval', async () => {
    const { inApp, approve, refunded } = app();
    await approve(await inApp({ orderId: 'B' }));
    const other = userActor({ id: 'u-3', orgId: 'o1', permissions: ['order:refund'] });
    expect(await inApp({ orderId: 'B' }, other)).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
  });
});

describe('in-app, what opens no row', () => {
  test('a caller the policy refuses outright', async () => {
    const { inApp, openedCount, refunded } = app();
    const answer = await inApp({ orderId: 'B' }, userActor({ id: 'u-9', orgId: 'o1' }));
    expect(answer).toContain('X_FORBIDDEN');
    expect(openedCount()).toBe(0);
    expect(refunded).toEqual([]);
  });

  test('arguments the action refuses: X_INPUT_INVALID', async () => {
    const { inApp, openedCount, refunded } = app();
    expect(await inApp({ orderId: 7 })).toContain('X_INPUT_INVALID');
    expect(openedCount()).toBe(0);
    expect(refunded).toEqual([]);
  });

  // The action's own parse DROPS an unknown key, so "failed the wire check, let `invoke` refuse it"
  // is a bypass: invoke would not refuse it, and the handler would run with nobody asked.
  test('an invented property is refused here, never waved through to a parse that drops it', async () => {
    const { inApp, openedCount, refunded } = app();
    expect(await inApp({ orderId: 'B', sneak: true })).toContain('X_INPUT_INVALID');
    expect(openedCount()).toBe(0);
    expect(refunded).toEqual([]);
  });
});

describe('the decision action stays out of reach of an agent', () => {
  const prompt = definePrompt({
    id: 'scripts.ai-tool-confirmation',
    version: '1',
    template: 'Decide.',
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'object', properties: {}, required: [] },
  });

  test('`agent({ tools: [decide] })` is X_AGENT_TOOL_UNEXPOSED at declaration', () => {
    const { confirmRefunds } = app();
    expect(() =>
      agent({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        prompt,
        vars: () => ({}),
        tools: [confirmRefunds],
        policy: can('order:confirm'),
      }),
    ).toThrow('X_AGENT_TOOL_UNEXPOSED');
  });
});

describe('several gates on one name', () => {
  test('in-app the first registered answers; each server keeps its own decider', async () => {
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
    const gate = (store: ReturnType<typeof memoryConfirmationStore>) =>
      mcpConfirmations({
        tools: ['refundOrder'],
        store,
        permission: 'order:confirm',
        sealKeys: sealKeys(),
      });
    const firstStore = memoryConfirmationStore();
    const secondStore = memoryConfirmationStore();
    const first = registerAction('firstDecider', gate(firstStore));
    const second = registerAction('secondDecider', gate(secondStore));
    const tool = asProjectableAction(refundOrder);
    const answer = await inRequest(() =>
      runLlmToolCall([tool], { id: 'c1', name: 'refundOrder', input: { orderId: 'B' } }, member),
    );
    const id = /confirmation ([0-9a-f-]{36})/.exec(answer.content)?.[1] ?? '';
    expect(await firstStore.get(id)).toBeDefined();
    expect(await secondStore.get(id)).toBeUndefined();
    expect(first.name).toBe('firstDecider');
    expect(second.name).toBe('secondDecider');
    expect(refunded).toEqual([]);
  });
});

describe('what the two surfaces note, for the manifest step', () => {
  test('a hand-written MCP tool and an agent in-process tool are known tool names', () => {
    defineAppMcp({
      tools: {
        seatReport: {
          description: 'Seats used. Read-only.',
          input: t.object({}),
          policy: 'order:refund',
          handle: () => ({ seats: 1 }),
        },
      },
    });
    agent({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      prompt: definePrompt({
        id: 'scripts.ai-tool-confirmation.noted',
        version: '1',
        template: 'Answer.',
        input: { type: 'object', properties: {}, required: [] },
        output: { type: 'object', properties: {}, required: [] },
      }),
      vars: () => ({}),
      tools: [
        inProcessTool({
          name: 'kbRead',
          description: 'Read one document.',
          input: t.object({}),
          execute: () => ({ ok: true }),
        }),
      ],
      policy: can('order:refund'),
    });
    expect(knownToolNames()).toEqual(['kbRead', 'seatReport']);
  });
});
