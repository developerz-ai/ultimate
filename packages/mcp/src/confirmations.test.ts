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
  generateMasterKey,
  isUltimateError,
  resetCursorSigning,
  SECRETS_KEY_ENV,
  userActor,
} from '@ultimat3/core';
import type { JsonValue } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpAuditEvent } from './audit-hook';
import type { McpConfirmationStore } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';
import type { McpConfirmationsInput } from './confirmations';
import { mcpConfirmations } from './confirmations';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';

afterEach(() => {
  resetRegistry();
  resetCursorSigning();
});

/** The seal key the gate stores arguments under — injected, so no `.secrets.key` is read. */
const SEAL = {
  root: '/nonexistent/mcp-confirmations',
  env: { [SECRETS_KEY_ENV]: generateMasterKey() },
};

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
  /** A person's whole flow: VIEW the request, then decide on exactly the arguments shown. */
  readonly decide: (id: string, decision: 'approve' | 'reject', actor?: Actor) => Promise<unknown>;
  readonly view: (id: string, actor?: Actor) => Promise<{ arguments: unknown; status: string }>;
  readonly decideWith: (
    id: string,
    decision: 'approve' | 'reject',
    args: Readonly<Record<string, JsonValue>> | undefined,
    actor?: Actor,
  ) => Promise<unknown>;
  readonly runs: { count: number };
  readonly store: McpConfirmationStore;
  readonly advance: (ms: number) => void;
  readonly events: McpAuditEvent[];
}

function harness(ttlMs = 60_000, check?: McpConfirmationsInput['check']): Harness {
  const runs = { count: 0 };
  const store = memoryConfirmationStore();
  const { clock, advance } = movable();
  const confirmRefunds = mcpConfirmations({
    tools: ['refundOrder'],
    store,
    permission: 'mcp:confirm',
    ...(check === undefined ? {} : { check }),
    ttlMs,
    clock,
    sealKeys: SEAL,
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
    view: (confirmation, actor = human) =>
      confirmRefunds.as(actor, { id: confirmation, decision: 'view' }),
    decideWith: (confirmation, decision, args, actor = human) =>
      confirmRefunds.as(actor, {
        id: confirmation,
        decision,
        ...(args === undefined ? {} : { arguments: args }),
      }),
    async decide(confirmation, decision, actor = human) {
      const shown = await confirmRefunds.as(actor, { id: confirmation, decision: 'view' });
      return confirmRefunds.as(actor, {
        id: confirmation,
        decision,
        arguments: shown.arguments ?? {},
      });
    },
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
  test('the view shows the person EXACTLY the arguments the agent sent, sealed at rest', async () => {
    const h = harness();
    const id = idIn((await h.call('o-17')).text);
    expect(await h.view(id)).toMatchObject({ status: 'pending', arguments: { orderId: 'o-17' } });
    const row = await h.store.get(id);
    expect(row?.sealedArguments.startsWith('x1.')).toBe(true);
    expect(row?.sealedArguments).not.toContain('o-17');
    expect((await h.store.get(id))?.status).toBe('pending');
  });

  test('approving different arguments than the agent sent is refused, and nothing runs', async () => {
    const h = harness();
    const id = idIn((await h.call('o-17')).text);
    expect(await codeOf(h.decideWith(id, 'approve', { orderId: 'o-5' }))).toBe(
      'X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH',
    );
    expect(await codeOf(h.decideWith(id, 'approve', undefined))).toBe(
      'X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH',
    );
    expect((await h.store.get(id))?.status).toBe('pending');
    expect((await h.call('o-17')).text).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(0);
  });

  test('the view never reaches an agent, nor a person in another org', async () => {
    const h = harness();
    const id = idIn((await h.call('o-17')).text);
    const permittedAgent = agentActor({ id: 'agent-1', orgId: 'o1', permissions: ['mcp:confirm'] });
    expect(await codeOf(h.view(id, permittedAgent))).toBe('X_FORBIDDEN');
    const outsider = userActor({ id: 'u-2', orgId: 'o2', permissions: ['mcp:confirm'] });
    expect(await codeOf(h.view(id, outsider))).toBe('X_FORBIDDEN');
  });

  const outsider = userActor({ id: 'u-2', orgId: 'o2', permissions: ['mcp:confirm'] });

  test('by default a decider stays inside the asking org', async () => {
    const fenced = harness();
    const id = idIn((await fenced.call('o-1')).text);
    expect(await codeOf(fenced.decide(id, 'approve', outsider))).toBe('X_FORBIDDEN');
    expect((await fenced.store.get(id))?.status).toBe('pending');
  });

  test('crossing tenants takes an explicit check', async () => {
    const crossing = harness(60_000, ({ row }) => row !== null);
    const id = idIn((await crossing.call('o-1')).text);
    expect(await crossing.decide(id, 'approve', outsider)).toMatchObject({ status: 'approved' });
  });

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

  test('an id no confirmation has: the default check refuses it before saying it is absent', async () => {
    const h = harness();
    const missing = '00000000-0000-4000-8000-000000000000';
    // The default fails closed on `row === null`: no "unknown" vs "someone else's" oracle.
    expect(await codeOf(h.view(missing))).toBe('X_FORBIDDEN');
    const open = mcpConfirmations({
      tools: ['refundOrder'],
      store: h.store,
      permission: 'mcp:confirm',
      check: () => true,
    });
    registerAction('confirmAnything', open);
    expect(await codeOf(open.as(human, { id: missing, decision: 'view' }))).toBe(
      'X_MCP_CONFIRMATION_UNKNOWN',
    );
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
      sealKeys: SEAL,
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
