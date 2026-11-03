// The adapter's half of the tool gate, over a stand-in `ToolGate`: `mcp` is this package's own tier,
// so the real `mcpConfirmations` meets the adapter in `scripts/ai-tool-confirmation.test.ts`, the one
// place both are reachable. Here: the order (actor half, gate, invoke), what the gate is handed, that
// it is read at call time, and that no way of handing the loop a tool steps around it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerToolGate, resetActions, type ToolGate } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { agentActor, ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { allow, can, clearPermissions } from '@ultimat3/policy';
import { t, toWireSchema } from '@ultimat3/schema';
import { inProcessTool } from './in-process-tool';
import type { ProjectableAction } from './tools';
import { asProjectableAction, runLlmToolCall } from './tools';

// Another file's `definePermissions` must not decide whether `can('order:refund')` declares.
beforeEach(() => clearPermissions());
afterEach(() => resetActions());

const permitted: Actor = agentActor({ id: 'a1', orgId: 'o1', permissions: ['order:refund'] });
const stranger: Actor = agentActor({ id: 'a2', orgId: 'o1' });
const Input = t.object({ orderId: t.string, reason: t.string.default('asked') });

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

function refundOrder() {
  const refunded: string[] = [];
  const tool = action({
    input: Input,
    output: t.object({ ok: t.boolean }),
    policy: can('order:refund'),
    mcp: { expose: true },
    handle: ({ input }) => {
      refunded.push(input.orderId);
      return { ok: true };
    },
  }).named('refundOrder');
  return { tool, refunded };
}

/** A gate that refuses until told otherwise, keeping what it was asked. */
function standIn() {
  const calls: Parameters<ToolGate>[0][] = [];
  const state = { open: false };
  const gate: ToolGate = (call, run) => {
    calls.push(call);
    if (state.open) return run();
    throw new UltimateError({
      code: 'X_MCP_CONFIRMATION_PENDING',
      cause: `${call.tool} waits for a person`,
      fix: 'x errors explain X_MCP_CONFIRMATION_PENDING',
      callerFix: 'ask a person to approve it, then call it again',
    });
  };
  return { gate, calls, state };
}

const call = (input: Record<string, unknown>, name = 'refundOrder') => ({
  id: 'c1',
  name,
  input,
});

describe('a gated tool, through the adapter', () => {
  test('the gate holds it: the model reads the code and the caller fix, the handler never ran', async () => {
    const { tool, refunded } = refundOrder();
    registerToolGate(['refundOrder'], standIn().gate);
    const result = await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({ orderId: 'B' }), permitted),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(result.content).toContain('ask a person to approve it');
    expect(refunded).toEqual([]);
  });

  test('the gate lets it through to invoke, which still parses and runs as the given actor', async () => {
    const { tool, refunded } = refundOrder();
    const held = standIn();
    held.state.open = true;
    registerToolGate(['refundOrder'], held.gate);
    const result = await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({ orderId: 'B' }), permitted),
    );
    expect(result.content).toBe('{"ok":true}');
    expect(refunded).toEqual(['B']);
  });

  test('the gate is handed the name, the arguments, the published schema and the actor', async () => {
    const { tool } = refundOrder();
    const held = standIn();
    registerToolGate(['refundOrder'], held.gate);
    await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({ orderId: 'B' }), permitted),
    );
    expect(held.calls).toEqual([
      {
        tool: 'refundOrder',
        args: { orderId: 'B' },
        inputSchema: toWireSchema(Input),
        actor: permitted,
      },
    ]);
  });

  test('a caller the policy refuses outright is X_FORBIDDEN and never reaches the gate', async () => {
    const { tool } = refundOrder();
    const held = standIn();
    registerToolGate(['refundOrder'], held.gate);
    const result = await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({ orderId: 'B' }), stranger),
    );
    expect(result.content).toContain('X_FORBIDDEN');
    expect(held.calls).toEqual([]);
  });

  test('outside any request the actor half still answers, rather than X_NO_CONTEXT', async () => {
    const { tool } = refundOrder();
    const held = standIn();
    registerToolGate(['refundOrder'], held.gate);
    const result = await runLlmToolCall(
      [asProjectableAction(tool)],
      call({ orderId: 'B' }),
      stranger,
    );
    expect(result.content).toContain('X_FORBIDDEN');
  });

  test('read at call time: a gate registered after projection still holds the tool', async () => {
    const { tool, refunded } = refundOrder();
    const projected = asProjectableAction(tool);
    registerToolGate(['refundOrder'], standIn().gate);
    const result = await inRequest(() =>
      runLlmToolCall([projected], call({ orderId: 'B' }), permitted),
    );
    expect(result.content).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(refunded).toEqual([]);
  });

  test('an ungated tool meets no gate', async () => {
    const { tool, refunded } = refundOrder();
    registerToolGate(['otherTool'], standIn().gate);
    await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({ orderId: 'B' }), permitted),
    );
    expect(refunded).toEqual(['B']);
  });

  test('a real action gated through `.run` directly is held too', async () => {
    const { tool, refunded } = refundOrder();
    registerToolGate(['refundOrder'], standIn().gate);
    await expect(
      inRequest(() => asProjectableAction(tool).run({ input: { orderId: 'B' }, actor: permitted })),
    ).rejects.toMatchObject({ code: 'X_MCP_CONFIRMATION_PENDING' });
    expect(refunded).toEqual([]);
  });
});

describe('a hand-built tool under a gated name', () => {
  const handBuilt = (ran: string[]): ProjectableAction => ({
    name: 'refundOrder',
    mcp: { expose: true },
    run: async ({ input }) => {
      ran.push(JSON.stringify(input));
      return { ok: true };
    },
  });

  test('through asProjectableAction, keeping its fields', async () => {
    const ran: string[] = [];
    const held = standIn();
    registerToolGate(['refundOrder'], held.gate);
    const projected = asProjectableAction(handBuilt(ran));
    expect(projected.name).toBe('refundOrder');
    expect(projected.mcp?.expose).toBe(true);
    const result = await runLlmToolCall([projected], call({ orderId: 'B' }), permitted);
    expect(result.content).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(held.calls[0]?.inputSchema).toBeUndefined();
    expect(ran).toEqual([]);
  });

  test('handed straight to runLlmToolCall, which is exported and documented', async () => {
    const ran: string[] = [];
    registerToolGate(['refundOrder'], standIn().gate);
    const result = await runLlmToolCall([handBuilt(ran)], call({ orderId: 'B' }), permitted);
    expect(result.content).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(ran).toEqual([]);
  });

  test('projected twice it meets the gate once, or an approval would be spent on the outer pass', async () => {
    const ran: string[] = [];
    const held = standIn();
    held.state.open = true;
    registerToolGate(['refundOrder'], held.gate);
    const once = asProjectableAction(handBuilt(ran));
    expect(asProjectableAction(once)).toBe(once);
    await runLlmToolCall([once], call({ orderId: 'B' }), permitted);
    expect(held.calls).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  test('an in-process tool under a gated name waits like any other', async () => {
    const ran: string[] = [];
    registerToolGate(['kbRead'], standIn().gate);
    const tool = inProcessTool({
      name: 'kbRead',
      description: 'Read one document by id.',
      input: t.object({ id: t.string }),
      execute: ({ input }) => {
        ran.push(input.id);
        return { ok: true };
      },
    });
    const result = await runLlmToolCall([tool], call({ id: 'k' }, 'kbRead'), permitted);
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });

  test('an action with an open policy still reaches the gate', async () => {
    const ran: string[] = [];
    const held = standIn();
    registerToolGate(['openTool'], held.gate);
    const tool = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      mcp: { expose: true },
      handle: () => {
        ran.push('ran');
        return { ok: true };
      },
    }).named('openTool');
    await inRequest(() =>
      runLlmToolCall([asProjectableAction(tool)], call({}, 'openTool'), stranger),
    );
    expect(held.calls).toHaveLength(1);
    expect(ran).toEqual([]);
  });
});

describe('a projected tool, copied or class-built', () => {
  test('a spread copy of a projected tool meets the gate once: approve and retry runs it', async () => {
    const { tool, refunded } = refundOrder();
    const held = standIn();
    held.state.open = true;
    registerToolGate(['refundOrder'], held.gate);
    const copy = { ...asProjectableAction(tool), description: 'Refund, reworded.' };
    const result = await inRequest(() => runLlmToolCall([copy], call({ orderId: 'B' }), permitted));
    expect(result.content).toBe('{"ok":true}');
    expect(held.calls).toHaveLength(1);
    expect(refunded).toEqual(['B']);
  });

  class ClassTool implements ProjectableAction {
    readonly ran: string[] = [];
    get name(): string {
      return 'classTool';
    }
    get mcp(): NonNullable<ProjectableAction['mcp']> {
      return { expose: true };
    }
    async run(args: { input: unknown; actor: Actor }): Promise<unknown> {
      this.ran.push(JSON.stringify(args.input));
      return { ok: true };
    }
  }

  test('a class-based tool keeps what its prototype declares, and is offered and gated', async () => {
    const tool = new ClassTool();
    registerToolGate(['classTool'], standIn().gate);
    const projected = asProjectableAction(tool);
    expect(projected.name).toBe('classTool');
    expect(projected.mcp?.expose).toBe(true);
    const result = await runLlmToolCall([tool], call({ id: 'k' }, 'classTool'), permitted);
    expect(result.content).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(tool.ran).toEqual([]);
  });

  test('a class-based tool under no gate runs with its own `this`', async () => {
    const tool = new ClassTool();
    const result = await runLlmToolCall([tool], call({ id: 'k' }, 'classTool'), permitted);
    expect(result.content).toBe('{"ok":true}');
    expect(tool.ran).toEqual(['{"id":"k"}']);
  });
});
