// `mcpConfirmations({ evidence })`, attacked: every vote an Ed25519 signature over its row's signing
// payload — unsigned, forged, replayed from another row, over another digest — verified at the
// decision, stored, and re-verified from the stored row before the call runs, by the gate or by a
// separate process holding public keys alone.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { confirmationSigningPayload, verifyConfirmationEvidence } from './confirmation-evidence';
import { MCP_CONFIRMATION_DIGEST_PURPOSE } from './confirmation-gate';
import {
  ana,
  BIG,
  ben,
  codeOf,
  harness,
  idIn,
  keyPair,
  registryVerify,
  sign,
  T0,
} from './confirmation-quorum-fixture';
import type { McpConfirmation } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';
import { mcpConfirmations } from './confirmations';

afterEach(() => resetActions());

describe('evidence: every vote signed over its row, verified, stored and re-verified', () => {
  test('ATTACK unsigned: an approval with no signature stores no vote', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    const error = await h.approve(id, ana, { signature: null }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      code: 'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
      meta: { reason: 'missing' },
    });
    expect((await h.store.get(id))?.approvals).toEqual([]);
  });

  test('ATTACK forged: a signature by a key not registered to the approver is refused', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    // Ben's real key signing as Ana, and a well-formed signature by a key nobody registered.
    expect(await codeOf(h.approve(id, ana, { signer: 'u-ben' }))).toBe(
      'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
    );
    const stranger = await keyPair();
    const forged = await sign(
      stranger,
      (await h.confirm.as(ana, { id, decision: 'view' })).signingPayload,
    );
    expect(await codeOf(h.approve(id, ana, { signature: forged }))).toBe(
      'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
    );
    expect((await h.store.get(id))?.approvals).toEqual([]);
  });

  test('ATTACK replayed: a valid signature from an earlier confirmation binds that row only', async () => {
    const h = await harness();
    const small = { orderId: 'o-3', amount: 10 };
    const first = idIn(await h.call(small));
    const firstPayload = (await h.confirm.as(ana, { id: first, decision: 'view' })).signingPayload;
    const old = await sign(h.keys.get('u-ana') ?? expect.unreachable('no key'), firstPayload);
    await h.approve(first, ana, { signature: old });
    expect(await h.call(small)).toBe('refunded o-3');
    // The identical call again opens a new row: the same arguments, the same digest, a new id.
    const second = idIn(await h.call(small));
    expect(second).not.toBe(first);
    expect(await codeOf(h.approve(second, ana, { signature: old }))).toBe(
      'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
    );
    expect(h.runs.count).toBe(1);
  });

  test("ATTACK signature over a different digest: signing another call's payload approves nothing", async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    const row = (await h.store.get(id)) ?? expect.unreachable('no row');
    const otherDigest = confirmationSigningPayload({ ...row, inputDigest: `${row.inputDigest}0` });
    expect(await codeOf(h.approve(id, ana, { payload: otherDigest }))).toBe(
      'X_MCP_CONFIRMATION_EVIDENCE_INVALID',
    );
  });

  test('ATTACK tampered row: a store written around the decision runs nothing', async () => {
    type Tamper = (row: McpConfirmation) => McpConfirmation;
    /** Each alteration, and the approvers who really voted before it was made. */
    const tampers: readonly (readonly [Tamper, readonly Actor[]])[] = [
      // A vote dropped, so the approved status outruns its evidence.
      [(row) => ({ ...row, approvals: row.approvals.slice(0, 1) }), [ana, ben]],
      // A second vote duplicated from the first, standing in for a missing approver.
      [
        (row) => ({
          ...row,
          approvals: [row.approvals[0], row.approvals[0]].filter((v) => v !== undefined),
        }),
        [ana, ben],
      ],
      // A signature swapped for another approver's.
      [
        (row) => ({
          ...row,
          approvals: row.approvals.map((vote) => ({
            ...vote,
            signature: row.approvals[1]?.signature ?? null,
          })),
        }),
        [ana, ben],
      ],
      // The bar lowered and a half-approved row flipped by hand.
      [
        (row) => (row.approvals.length === 1 ? { ...row, status: 'approved', quorum: 1 } : row),
        [ana],
      ],
    ];
    for (const [tamper, voters] of tampers) {
      resetActions();
      const h = await harness({ tamper });
      const id = idIn(await h.call(BIG));
      for (const voter of voters) await h.approve(id, voter);
      expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_EVIDENCE_INVALID');
      expect(h.runs.count).toBe(0);
      // Delivered once, then the call asks again.
      expect(await h.call(BIG)).toContain('X_MCP_CONFIRMATION_PENDING');
    }
  });

  test('a verifier that throws is an outage, not a verdict: the approval waits for a retry', async () => {
    const h = await harness();
    const small = { orderId: 'o-4', amount: 10 };
    const id = idIn(await h.call(small));
    await h.approve(id, ana);
    h.failVerify(true);
    expect(await h.call(small)).not.toContain('refunded');
    expect((await h.store.get(id))?.consumedAt).toBeNull();
    h.failVerify(false);
    expect(await h.call(small)).toBe('refunded o-4');
  });

  test('a separate process verifies the stored row with public keys and the arguments alone', async () => {
    const h = await harness();
    const id = idIn(await h.call(BIG));
    await h.approve(id, ana);
    await h.approve(id, ben);
    const stored = (await h.store.get(id)) ?? expect.unreachable('no row');
    expect(stored.approvals.every((vote) => typeof vote.signature === 'string')).toBe(true);
    const evidence = { verify: h.verify };
    expect(await verifyConfirmationEvidence(stored, { evidence, arguments: BIG })).toEqual({
      ok: true,
      approvers: ['u-ana', 'u-ben'],
    });
    expect(
      await verifyConfirmationEvidence(stored, { evidence, arguments: { ...BIG, amount: 1 } }),
    ).toEqual({
      ok: false,
      reason: 'binding',
    });
    expect(await verifyConfirmationEvidence(stored, { evidence, quorum: 3 })).toEqual({
      ok: false,
      reason: 'quorum',
    });
    const revoked = registryVerify(
      new Map([['u-ana', h.keys.get('u-ana') ?? expect.unreachable('no key')]]),
    );
    expect(await verifyConfirmationEvidence(stored, { evidence: { verify: revoked } })).toEqual({
      ok: false,
      reason: 'refused',
    });
    // A vote in the requester's name counts for nothing, even with signatures left unchecked.
    const selfVoted = {
      ...stored,
      approvals: [
        stored.approvals[0] ?? expect.unreachable('no vote'),
        { ...stored.approvals[0], approver: 'agent-1', at: new Date(T0), signature: null },
      ],
    };
    expect(await verifyConfirmationEvidence(selfVoted)).toEqual({ ok: false, reason: 'quorum' });
    // The digest purpose the verifier restates is the gate's own.
    expect(MCP_CONFIRMATION_DIGEST_PURPOSE).toBe('mcp-confirmation');
  });

  test('a declaration whose evidence has no verify is refused at boot', () => {
    expect(() =>
      mcpConfirmations({
        tools: ['refundOrder'],
        store: memoryConfirmationStore(),
        permission: 'mcp:confirm',
        evidence: {} as unknown as { verify: () => boolean },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_MCP_CONFIRMATION_QUORUM_INVALID' }));
  });
});
