// `mcpConfirmations` across orgs: an actor id that stays the same in two orgs (a tenant server's
// agent, an in-app agent switching its active org) must not carry an approval from one into the
// other. The store keys the open row by org; the gate refuses a row of another org if one reaches it.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { agentActor } from '@ultimat3/core';
import { agent, ana, finance, harness, idIn } from './confirmation-quorum-fixture';

afterEach(() => resetActions());

const SMALL = { orderId: 'o-9', amount: 10 };
const inO2 = agentActor({ id: 'agent-1', orgId: 'o2' });

describe('a confirmation belongs to the org it was opened in', () => {
  test('ATTACK approved in o1, called as the same id in o2: o2 asks its own people', async () => {
    const h = await harness();
    const id = idIn(await h.call(SMALL, agent));
    expect(await h.approve(id, ana)).toMatchObject({ status: 'approved' });
    const inOther = await h.call(SMALL, inO2);
    expect(inOther).toContain('X_MCP_CONFIRMATION_PENDING');
    expect(idIn(inOther)).not.toBe(id);
    expect(h.runs.count).toBe(0);
    // o1's approval is untouched, and still runs o1's call exactly once.
    expect(await h.call(SMALL, agent)).toBe('refunded o-9');
    expect(h.runs.count).toBe(1);
    // o2's own row is decided by o2's people (a finance user of o2, holding a registered key).
    const theirs = idIn(inOther);
    expect(await h.approve(theirs, finance('u-ben', { orgId: 'o2' }))).toMatchObject({
      status: 'approved',
    });
    expect(await h.call(SMALL, inO2)).toBe('refunded o-9');
    expect(h.runs.count).toBe(2);
  });

  test('ATTACK a store whose row names another org: refused before anything runs or consumes', async () => {
    // A store that answers the o2 call with a row stamped o1, as one keyed without the org would.
    const h = await harness({
      tamper: (row) => (row.orgId === 'o2' ? { ...row, orgId: 'o1' } : row),
    });
    const refused = await h.call(SMALL, inO2);
    expect(refused).toContain('X_MCP_CONFIRMATION_EVIDENCE_INVALID');
    expect(refused).toContain('another org');
    expect(h.runs.count).toBe(0);
    expect((await h.store.get(idIn(refused)))?.consumedAt).toBeNull();
  });
});
