// The ledger on its own: what a claim means, and the one thing it must never do — hand a second
// caller a delivery that already went out.

import { describe, expect, test } from 'bun:test';
import type { DeliveryClaim, DeliveryClaimAnswer } from './ledger';
import { DEFAULT_DELIVERY_RECLAIM_MS, isDeliveryStatus, memoryDeliveryLedger } from './ledger';

const AT = new Date('2026-08-24T09:00:00Z');
const claim: DeliveryClaim = {
  notifier: 'post.liked',
  key: 'like:p1',
  recipient: 'ana',
  channel: 'email',
};

/** The claim id of an answer that must have been `owned`. */
const owned = (answer: DeliveryClaimAnswer): string =>
  answer.outcome === 'owned' ? answer.claimId : expect.unreachable(`got ${answer.outcome}`);

const SENT = { outcome: 'sent' } as const;

describe('unit · delivery ledger', () => {
  test('a settled `sent` delivery is never claimable again', async () => {
    const ledger = memoryDeliveryLedger();
    await ledger.settle(claim, 'sent', AT, owned(await ledger.claim(claim, AT)));
    expect(await ledger.claim(claim, AT)).toEqual(SENT);
  });

  test('a delivery left mid-flight is held for its window, then re-claimable, and counted', async () => {
    // At-least-once is the honest guarantee: a process killed between the provider's 200 and the
    // settle leaves this row `sending`, and refusing it for good is a notification nobody gets.
    const ledger = memoryDeliveryLedger();
    owned(await ledger.claim(claim, AT));
    expect(await ledger.claim(claim, AT)).toEqual({
      outcome: 'held',
      retryAfterMs: DEFAULT_DELIVERY_RECLAIM_MS,
    });
    expect((await ledger.find(claim))?.attempts).toBe(1);

    owned(await ledger.claim(claim, new Date(AT.getTime() + DEFAULT_DELIVERY_RECLAIM_MS + 1)));
    expect((await ledger.find(claim))?.attempts).toBe(2);
    expect((await ledger.find(claim))?.status).toBe('sending');
  });

  test('a failed delivery is re-claimable, so the job retry decides — not the ledger', async () => {
    const ledger = memoryDeliveryLedger();
    await ledger.settle(claim, 'failed', AT, owned(await ledger.claim(claim, AT)));
    owned(await ledger.claim(claim, AT));
  });

  test('the four columns are one key, and none of them collides with a separator', async () => {
    const ledger = memoryDeliveryLedger();
    // `notifier:key` joined with a colon would read these two as the same delivery, and the loser
    // would be a notification that silently never arrives.
    const first = { notifier: 'a:b', key: 'c', recipient: 'ana', channel: 'email' };
    await ledger.settle(first, 'sent', AT, owned(await ledger.claim(first, AT)));
    owned(
      await ledger.claim({ notifier: 'a', key: 'b:c', recipient: 'ana', channel: 'email' }, AT),
    );
  });

  test('a bulk claim is one row for the audience, distinct from every per-recipient one', async () => {
    const ledger = memoryDeliveryLedger();
    const bulk = { ...claim, recipient: null, channel: 'slack' };
    await ledger.settle(bulk, 'sent', AT, owned(await ledger.claim(bulk, AT)));
    expect(await ledger.claim(bulk, AT)).toEqual(SENT);
    owned(await ledger.claim({ ...bulk, recipient: 'ana' }, AT));
  });

  test('a NULL and an empty recipient are one delivery, as the Postgres index reads them', async () => {
    // `coalesce(recipient, '')` is the pg ledger's key; a ledger that told the two apart would
    // send a bulk notification twice in dev and once in production.
    const ledger = memoryDeliveryLedger();
    const bulk = { ...claim, recipient: null, channel: 'slack' };
    const claimId = owned(await ledger.claim(bulk, AT));
    await ledger.settle({ ...bulk, recipient: '' }, 'sent', AT, claimId);
    expect(await ledger.claim(bulk, AT)).toEqual(SENT);
    expect(await ledger.claim({ ...bulk, recipient: '' }, AT)).toEqual(SENT);
    expect(ledger.size).toBe(1);
    expect((await ledger.find({ ...bulk, recipient: '' }))?.recipient).toBeNull();
  });

  test('a settle with no claim is a no-op, as the pg UPDATE that matches no row is', async () => {
    const ledger = memoryDeliveryLedger();
    expect(await ledger.settle(claim, 'sent', AT, crypto.randomUUID())).toBe(false);
    expect(ledger.size).toBe(0);
    owned(await ledger.claim(claim, AT));
  });

  test('a late settle changes nothing, and neither does a second settle by the owner', async () => {
    const ledger = memoryDeliveryLedger({ reclaimAfterMs: 1 });
    const late = owned(await ledger.claim(claim, AT));
    const current = owned(await ledger.claim(claim, new Date(AT.getTime() + 2)));
    expect(await ledger.settle(claim, 'failed', AT, late)).toBe(false);
    expect((await ledger.find(claim))?.status).toBe('sending');
    expect(await ledger.settle(claim, 'sent', AT, current)).toBe(true);
    expect(await ledger.settle(claim, 'failed', AT, current)).toBe(false);
    expect((await ledger.find(claim))?.status).toBe('sent');
  });

  test('the cap evicts oldest-first and PUBLISHES the drop, because a dropped row stops deduping', async () => {
    const ledger = memoryDeliveryLedger({ max: 2 });
    for (const recipient of ['ana', 'ben', 'cyd']) {
      await ledger.claim({ ...claim, recipient }, AT);
    }
    expect(ledger.size).toBe(2);
    expect(ledger.dropped).toBe(1);
  });

  test('a re-claimed row is the NEWEST at the cap: evicting it handed a concurrent second send', async () => {
    // `Map.set` on an existing key keeps its old position, so the row just re-claimed `sending`
    // was the first evicted, and the next attempt found no claim at all and sent too.
    const ledger = memoryDeliveryLedger({ max: 2 });
    const ana = { ...claim, recipient: 'ana' };
    await ledger.settle(ana, 'failed', AT, owned(await ledger.claim(ana, AT)));
    await ledger.claim({ ...claim, recipient: 'ben' }, AT);
    owned(await ledger.claim(ana, AT));
    await ledger.claim({ ...claim, recipient: 'cyd' }, AT);
    expect((await ledger.claim(ana, AT)).outcome).toBe('held');
  });

  test('a settled row is the newest too: evicting a fresh `sent` stopped deduping it first', async () => {
    const ledger = memoryDeliveryLedger({ max: 2 });
    const ana = { ...claim, recipient: 'ana' };
    const ownedAna = owned(await ledger.claim(ana, AT));
    await ledger.claim({ ...claim, recipient: 'ben' }, AT);
    await ledger.settle(ana, 'sent', AT, ownedAna);
    await ledger.claim({ ...claim, recipient: 'cyd' }, AT);
    expect(await ledger.claim(ana, AT)).toEqual(SENT);
  });

  test('clear() empties the ledger AND its drop count, so one suite cannot pin the next', async () => {
    const ledger = memoryDeliveryLedger({ max: 1 });
    await ledger.claim(claim, AT);
    await ledger.claim({ ...claim, recipient: 'ben' }, AT);
    expect(ledger.dropped).toBe(1);
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.dropped).toBe(0);
  });

  test('a status this package did not write is not a DeliveryStatus', () => {
    expect(isDeliveryStatus('sent')).toBe(true);
    expect(isDeliveryStatus('delivered')).toBe(false);
    expect(isDeliveryStatus(undefined)).toBe(false);
  });
});

/**
 * `while (rows.size > max)` is the whole eviction, and `NaN > NaN` is false for every size the map
 * will ever hold — so a cap that is not a number is not a small cap, it is NO cap, and this ledger
 * grows into the heap of a process that was told it was bounded. `??` does not screen it: `NaN` is
 * not nullish, so `Number(process.env.NOTIFY_LEDGER_MAX)` on an unset variable arrives intact.
 */
describe('unit · delivery ledger, a cap that is not a cap', () => {
  for (const reclaimAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    test(`reclaimAfterMs: ${String(reclaimAfterMs)} is refused where it is written`, () => {
      expect(() => memoryDeliveryLedger({ reclaimAfterMs })).toThrow(/X_INVARIANT/);
    });
  }

  for (const max of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1, 0]) {
    test(`max: ${String(max)} is refused where it is written, never silently unbounded`, () => {
      expect(() => memoryDeliveryLedger({ max })).toThrow(/X_INVARIANT/);
    });
  }

  test('a real cap still evicts, so the refusal did not replace the behaviour', async () => {
    const ledger = memoryDeliveryLedger({ max: 1 });
    await ledger.claim(claim, AT);
    await ledger.claim({ ...claim, recipient: 'bo' }, AT);
    expect(ledger.size).toBe(1);
    expect(ledger.dropped).toBe(1);
  });
});
