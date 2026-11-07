// `mcpConfirmations({ approvers })`, attacked: N of M distinct approvers resolved per call from its
// validated arguments, the requester never counting, one vote per approver, a partial row expiring
// and a rejection settling it. Each test is one way past the gate, and the call must not run.
// The signed-evidence half is `confirmations-evidence.test.ts`; the harness is the fixture.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import type { McpConfirmationApprovers } from './confirmation-approvers';
import {
  agent,
  ana,
  BIG,
  ben,
  codeOf,
  finance,
  harness,
  idIn,
  T0,
  TTL,
} from './confirmation-quorum-fixture';

afterEach(() => resetActions());

describe('quorum: N of M distinct approvers, resolved per call from its arguments', () => {
  test('two of finance: one approval waits, the second runs the call exactly once', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    expect(await h.approve(id, ana)).toMatchObject({
      status: 'pending',
      quorum: 2,
      approvedBy: ['u-ana'],
    });
    const waiting = await h.call(BIG);
    expect(waiting).toContain('X_MCP_CONFIRMATION_QUORUM_PENDING');
    expect(waiting).toContain('1 of the 2');
    expect(h.runs.count).toBe(0);
    expect(await h.approve(id, ben)).toMatchObject({
      status: 'approved',
      approvedBy: ['u-ana', 'u-ben'],
    });
    expect(await h.call(BIG)).toBe('refunded o-1');
    expect(h.runs.count).toBe(1);
    expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(1);
  });

  test('the bar comes from the arguments: a small refund needs one approver', async () => {
    const h = await harness();
    const small = { orderId: 'o-2', amount: 10 };
    const id = idIn(await h.call(small));
    expect((await h.store.get(id))?.quorum).toBe(1);
    expect(await h.approve(id, ana)).toMatchObject({ status: 'approved' });
    expect(await h.call(small)).toBe('refunded o-2');
  });

  test('ATTACK requester self-approval: the asking actor never counts, whatever it holds', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    // A person principal sharing the agent's id — "the user whose agent asked" — holds finance too.
    const self = finance('agent-1');
    expect(await codeOf(h.approve(id, self))).toBe('X_FORBIDDEN');
    expect(await codeOf(h.approve(id, agent))).toBe('X_FORBIDDEN');
    expect((await h.store.get(id))?.approvals).toEqual([]);
  });

  test('ATTACK duplicate approver: a second vote is never a second approver', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    await h.approve(id, ana);
    expect(await codeOf(h.approve(id, ana))).toBe('X_MCP_CONFIRMATION_QUORUM_PENDING');
    // Straight at the store too: the CAS refuses it even past the decision action's check.
    expect(
      await h.store.decide(id, 'approved', 'u-ana', new Date(T0 + 1), 'again'),
    ).toBeUndefined();
    expect((await h.store.get(id))?.approvals).toHaveLength(1);
    expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_QUORUM_PENDING');
    expect(h.runs.count).toBe(0);
  });

  test('a decider outside `from`, or wearing someone through impersonation, is refused', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    const sales = userActor({
      id: 'u-sal',
      orgId: 'o1',
      roles: ['sales'],
      permissions: ['mcp:confirm'],
    });
    expect(await codeOf(h.approve(id, sales))).toBe('X_FORBIDDEN');
    const worn = finance('u-ben', { onBehalfOf: { actorId: 'support-1', actorKind: 'user' } });
    expect(await codeOf(h.approve(id, worn))).toBe('X_FORBIDDEN');
    expect((await h.store.get(id))?.approvals).toEqual([]);
  });

  test('one rejection rejects a partly approved call', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    await h.approve(id, ana);
    await h.confirm.as(ben, { id, decision: 'reject' });
    expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_REJECTED');
    expect(h.runs.count).toBe(0);
  });

  test('ATTACK expired: a half-met quorum lapses on ttlMs like any confirmation', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    await h.approve(id, ana);
    h.advance(TTL);
    expect(await codeOf(h.approve(id, ben))).toBe('X_MCP_CONFIRMATION_EXPIRED');
    expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_EXPIRED');
    expect(h.runs.count).toBe(0);
  });

  test('ATTACK rotated arguments: an approval of other arguments decides nothing, and other arguments ride nothing', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    const swapped = { orderId: 'o-1', amount: 9_999_999 };
    expect(await codeOf(h.approve(id, ana, { arguments: swapped }))).toBe(
      'X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH',
    );
    await h.approve(id, ana);
    await h.approve(id, ben);
    expect(await h.call(swapped)).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(h.runs.count).toBe(0);
  });

  test('a bar nobody can meet is refused before a row opens', async () => {
    for (const bar of [
      { quorum: 0, from: ['role:finance'] },
      { quorum: 1.5, from: ['role:finance'] },
      { quorum: 1, from: [] },
      { quorum: 1, from: ['finance'] },
      // The only named approver is the requester, who never counts.
      { quorum: 1, from: ['actor:agent-1'] },
      { quorum: 2, from: ['actor:u-ana', 'actor:agent-1'] },
    ] as const) {
      resetActions();
      const h = await harness({ approvers: () => bar as unknown as McpConfirmationApprovers });
      expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_QUORUM_INVALID');
    }
  });

  test('named actors: two of three, requester excluded, and only the named count', async () => {
    const h = await harness({
      approvers: () => ({ quorum: 2, from: ['actor:u-ana', 'actor:u-ben', 'actor:agent-1'] }),
    });
    const id = idIn(await h.call(BIG));
    expect(await codeOf(h.approve(id, finance('u-eve')))).toBe('X_FORBIDDEN');
    await h.approve(id, ana);
    await h.approve(id, ben);
    expect(await h.call(BIG)).toBe('refunded o-1');
  });
});
