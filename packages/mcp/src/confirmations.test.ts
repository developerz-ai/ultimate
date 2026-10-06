// `mcpConfirmations`: an agent's call to a gated tool opens a pending row and does not run; a person
// approves or rejects it through an ordinary ACTION; the agent's same call then runs once — or is
// told it was rejected or expired. A factory over `action`, so the decision has a route, a policy
// and an audit record like every other write.

import { afterEach, describe, expect, test } from 'bun:test';
import { registerAction, resetRegistry } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import {
  agentActor,
  canonicalJson,
  configureCursorSigning,
  frozenClock,
  isUltimateError,
  resetCursorSigning,
  userActor,
} from '@ultimat3/core';
import { defineAppMcp } from './app-tools';
import type { McpAuditEvent } from './audit-hook';
import type { McpConfirmationStore } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';

afterEach(() => {
  resetRegistry();
  resetCursorSigning();
});

const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const human = userActor({ id: 'u-9', orgId: 'o1', permissions: ['mcp:confirm'] });
const agent = agentActor({ id: 'agent-1', orgId: 'o1' });
const asCaller = (actor: Actor): McpCaller => ({ actor, scopes: new Set() });

/** A clock a test moves: frozen at `T0 + offset`. */
const movable = () => {
  let offset = 0;
  return {
    clock: { now: () => new Date(T0 + offset), monotonic: () => offset },
    advance: (ms: number) => {
      offset += ms;
    },
  };
};

const refundTool = (runs: { count: number }): AnyMcpTool => ({
  name: 'refundOrder',
  description: 'refunds an order',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
    additionalProperties: false,
  },
  async handle(args) {
    runs.count += 1;
    return textResult(`refunded ${String(args['orderId'])}`);
  },
});

const echoTool: AnyMcpTool = {
  name: 'echo',
  description: 'echoes',
  destructive: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handle() {
    return textResult('ok');
  },
};

interface Harness {
  readonly call: (orderId: string, actor?: Actor) => Promise<{ text: string; isError: boolean }>;
  readonly decide: (id: string, decision: 'approve' | 'reject', actor?: Actor) => Promise<unknown>;
  readonly runs: { count: number };
  readonly store: McpConfirmationStore;
  readonly advance: (ms: number) => void;
  readonly events: McpAuditEvent[];
}

function harness(ttlMs = 60_000): Harness {
  const runs = { count: 0 };
  const store = memoryConfirmationStore();
  const { clock, advance } = movable();
  const confirmRefunds = mcpConfirmations({
    tools: ['refundOrder'],
    store,
    permission: 'mcp:confirm',
    check: ({ actor, row }) => row !== null && row.orgId === actor?.orgId,
    ttlMs,
    clock,
  });
  registerAction('confirmRefunds', confirmRefunds);
  const events: McpAuditEvent[] = [];
  const app = defineAppMcp({
    tools: [refundTool(runs), echoTool],
    confirmations: confirmRefunds,
    errorAudience: 'developer',
    onAudit: (event) => void events.push(event),
  });
  let id = 0;
  return {
    runs,
    store,
    advance,
    events,
    async call(orderId, actor = agent) {
      id += 1;
      const response = await app.server.handle(
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'refundOrder', arguments: { orderId } },
        },
        asCaller(actor),
      );
      const result = response?.result as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]?.text ?? '', isError: result.isError === true };
    },
    decide: (confirmation, decision, actor = human) =>
      confirmRefunds.as(actor, { id: confirmation, decision }),
  };
}

const idIn = (text: string): string => {
  const match = /confirmation ([0-9a-f-]{36})/.exec(text);
  if (match?.[1] === undefined) expect.unreachable(`no confirmation id in: ${text}`);
  return match[1];
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return isUltimateError(thrown) ? thrown.code : 'not-an-ultimate-error';
  }
};

describe('the agent side: a gated call waits for a person', () => {
  test('the first call opens a pending confirmation and does not run', async () => {
    const h = harness();
    const first = await h.call('o-1');
    expect(first.isError).toBe(true);
    expect(first.text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(0);
    const row = await h.store.get(idIn(first.text));
    expect(row).toMatchObject({
      status: 'pending',
      actorId: 'agent-1',
      orgId: 'o1',
      tool: 'refundOrder',
    });
    // Keyed (HMAC under the app's signing secret), never an unkeyed hash a database read could
    // brute-force back to a low-entropy argument.
    expect(row?.inputDigest).toMatch(/^h1:[0-9a-f]{8}:[0-9a-f]{32}$/);
    const unkeyed = new Bun.CryptoHasher('sha256')
      .update(canonicalJson({ orderId: 'o-1' }))
      .digest('hex');
    expect(row?.inputDigest).not.toContain(unkeyed.slice(0, 32));
    expect(h.events.at(-1)).toMatchObject({ kind: 'tool-call', outcome: 'unconfirmed' });
  });

  test('repeating the call while pending answers the SAME confirmation', async () => {
    const h = harness();
    const first = idIn((await h.call('o-1')).text);
    expect(idIn((await h.call('o-1')).text)).toBe(first);
    expect(idIn((await h.call('o-2')).text)).not.toBe(first);
  });

  test('approved, the same call runs exactly once; the next one asks again', async () => {
    const h = harness();
    const id = idIn((await h.call('o-1')).text);
    expect(await h.decide(id, 'approve')).toMatchObject({
      id,
      status: 'approved',
      tool: 'refundOrder',
    });
    const ran = await h.call('o-1');
    expect(ran).toEqual({ text: 'refunded o-1', isError: false });
    expect(h.runs.count).toBe(1);
    const again = await h.call('o-1');
    expect(again.text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(idIn(again.text)).not.toBe(id);
    expect(h.runs.count).toBe(1);
  });

  test('an approval binds to the input: different arguments do not ride it', async () => {
    const h = harness();
    await h.decide(idIn((await h.call('o-1')).text), 'approve');
    expect((await h.call('o-999')).text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(0);
  });

  test('an approval binds to the agent: another agent does not ride it', async () => {
    const h = harness();
    await h.decide(idIn((await h.call('o-1')).text), 'approve');
    const other = agentActor({ id: 'agent-2', orgId: 'o1' });
    expect((await h.call('o-1', other)).text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(0);
  });

  test('a rotated signing secret is no approval: the same call opens a FRESH confirmation', async () => {
    configureCursorSigning('secret-before-rotation-0123456789abcdef');
    const h = harness();
    const before = idIn((await h.call('o-1')).text);
    await h.decide(before, 'approve');
    configureCursorSigning('secret-after-rotation-fedcba9876543210');
    const after = await h.call('o-1');
    // Never a mismatch error and never the old approval: the digest under the new key matches no
    // row, so this is a new request for a person to decide.
    expect(after.text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(idIn(after.text)).not.toBe(before);
    expect(h.runs.count).toBe(0);
    expect((await h.store.get(before))?.status).toBe('approved');
  });

  test('rejected, the call is told so once, audited as a denial, and does not run', async () => {
    const h = harness();
    const id = idIn((await h.call('o-1')).text);
    await h.decide(id, 'reject');
    const told = await h.call('o-1');
    expect(told.text).toContain('X_MCP_CONFIRMATION_REJECTED');
    expect(h.events.at(-1)).toMatchObject({ outcome: 'policy-denied' });
    expect(h.runs.count).toBe(0);
    expect((await h.call('o-1')).text).toContain('X_MCP_CONFIRMATION_PENDING');
  });

  test('a call after expiry is X_MCP_CONFIRMATION_EXPIRED, even when it was approved', async () => {
    const h = harness(60_000);
    const id = idIn((await h.call('o-1')).text);
    await h.decide(id, 'approve');
    h.advance(60_000);
    const late = await h.call('o-1');
    expect(late.text).toContain('X_MCP_CONFIRMATION_EXPIRED');
    expect(h.runs.count).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ outcome: 'unconfirmed' });
  });

  test('ungated tools are untouched, and the gated one is marked for the catalog', async () => {
    const runs = { count: 0 };
    const store = memoryConfirmationStore();
    const gate = mcpConfirmations({ tools: ['refundOrder'], store, permission: 'mcp:confirm' });
    const app = defineAppMcp({ tools: [refundTool(runs), echoTool], confirmations: gate });
    expect(app.tools.find((tool) => tool.name === 'refundOrder')?.confirms).toBe(true);
    expect(app.tools.find((tool) => tool.name === 'echo')?.confirms).toBeUndefined();
    const echoed = await app.server.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      asCaller(agent),
    );
    expect(echoed?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });
});

describe('the person side: approve and reject are an action', () => {
  test('a decision is taken once: approve after reject (or twice) is X_MCP_CONFIRMATION_DECIDED', async () => {
    const h = harness();
    const id = idIn((await h.call('o-1')).text);
    await h.decide(id, 'reject');
    expect(await codeOf(h.decide(id, 'approve'))).toBe('X_MCP_CONFIRMATION_DECIDED');
    expect(await codeOf(h.decide(id, 'reject'))).toBe('X_MCP_CONFIRMATION_DECIDED');
  });

  test('a decision after expiry is X_MCP_CONFIRMATION_EXPIRED', async () => {
    const h = harness(60_000);
    const id = idIn((await h.call('o-1')).text);
    h.advance(60_001);
    expect(await codeOf(h.decide(id, 'approve'))).toBe('X_MCP_CONFIRMATION_EXPIRED');
  });

  test('an id no confirmation has is X_MCP_CONFIRMATION_UNKNOWN', async () => {
    const h = harness();
    const check = mcpConfirmations({
      tools: ['refundOrder'],
      store: h.store,
      permission: 'mcp:confirm',
    });
    registerAction('confirmAnything', check);
    expect(
      await codeOf(
        check.as(human, { id: '00000000-0000-4000-8000-000000000000', decision: 'approve' }),
      ),
    ).toBe('X_MCP_CONFIRMATION_UNKNOWN');
  });

  test('an agent never decides one — not even holding the permission', async () => {
    const h = harness();
    const id = idIn((await h.call('o-1')).text);
    const permitted = agentActor({ id: 'agent-1', orgId: 'o1', permissions: ['mcp:confirm'] });
    expect(await codeOf(h.decide(id, 'approve', permitted))).toBe('X_FORBIDDEN');
    expect((await h.store.get(id))?.status).toBe('pending');
  });

  test("the app's check decides who: another org is refused by the policy, not the state", async () => {
    const h = harness();
    const id = idIn((await h.call('o-1')).text);
    const outsider = userActor({ id: 'u-2', orgId: 'o2', permissions: ['mcp:confirm'] });
    expect(await codeOf(h.decide(id, 'approve', outsider))).toBe('X_FORBIDDEN');
    const unpermitted = userActor({ id: 'u-3', orgId: 'o1' });
    expect(await codeOf(h.decide(id, 'approve', unpermitted))).toBe('X_FORBIDDEN');
  });

  test('the decision action is never an MCP tool', () => {
    const gate = mcpConfirmations({
      tools: ['refundOrder'],
      store: memoryConfirmationStore(),
      permission: 'mcp:confirm',
    });
    registerAction('confirmRefundsHidden', gate);
    expect(gate.describe().mcp.expose).toBe(false);
  });
});

describe('boot refusals', () => {
  test('gating a tool the server does not project is X_MCP_CONFIRMATION_TOOL_UNKNOWN', () => {
    const gate = mcpConfirmations({
      tools: ['refundOrdr'],
      store: memoryConfirmationStore(),
      permission: 'mcp:confirm',
    });
    let code: string | undefined;
    try {
      defineAppMcp({ tools: [echoTool], confirmations: gate });
    } catch (thrown) {
      code = isUltimateError(thrown) ? thrown.code : undefined;
      expect(isUltimateError(thrown) && thrown.fix).toContain('echo');
    }
    expect(code).toBe('X_MCP_CONFIRMATION_TOOL_UNKNOWN');
  });

  test('an empty tools list gates nothing and is refused where it is declared', () => {
    let code: string | undefined;
    try {
      mcpConfirmations({ tools: [], store: memoryConfirmationStore(), permission: 'mcp:confirm' });
    } catch (thrown) {
      code = isUltimateError(thrown) ? thrown.code : undefined;
    }
    expect(code).toBe('X_MCP_CONFIRMATION_TOOL_UNKNOWN');
  });

  test('a ttl that is not a positive finite count is refused at construction', () => {
    expect(() =>
      mcpConfirmations({
        tools: ['refundOrder'],
        store: memoryConfirmationStore(),
        permission: 'mcp:confirm',
        ttlMs: Number.NaN,
      }),
    ).toThrow();
  });

  test('the clock is the injected one, never Date.now()', async () => {
    const store = memoryConfirmationStore();
    const runs = { count: 0 };
    const gate = mcpConfirmations({
      tools: ['refundOrder'],
      store,
      permission: 'mcp:confirm',
      ttlMs: 1_000,
      clock: frozenClock(T0),
    });
    const app = defineAppMcp({
      tools: [refundTool(runs)],
      confirmations: gate,
      errorAudience: 'developer',
    });
    const response = await app.server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'refundOrder', arguments: { orderId: 'x' } },
      },
      asCaller(agent),
    );
    const result = response?.result as { content: { text: string }[] } | undefined;
    const text = result?.content[0]?.text ?? '';
    const row = await store.get(idIn(text));
    expect(row?.createdAt.getTime()).toBe(T0);
    expect(row?.expiresAt.getTime()).toBe(T0 + 1_000);
    expect(text).toContain(new Date(T0 + 1_000).toISOString());
  });
});
