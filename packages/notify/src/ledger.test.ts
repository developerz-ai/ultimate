// The ledger on its own: what a claim means, and the one thing it must never do — hand a second
// caller a delivery that already went out.

import { describe, expect, test } from 'bun:test';
import type { DeliveryClaim } from './ledger';
import { createMemoryDeliveryLedger, isDeliveryStatus } from './ledger';

const AT = new Date('2026-08-24T09:00:00Z');
const claim: DeliveryClaim = {
  notifier: 'post.liked',
  key: 'like:p1',
  recipient: 'ana',
  channel: 'email',
};

describe('unit · delivery ledger', () => {
  test('a settled `sent` delivery is never claimable again', async () => {
    const ledger = createMemoryDeliveryLedger();
    expect(await ledger.claim(claim, AT)).toBe(true);
    await ledger.settle(claim, 'sent', AT);
    expect(await ledger.claim(claim, AT)).toBe(false);
  });

  test('a delivery left mid-flight IS re-claimable, and the attempt count says so', async () => {
    // At-least-once is the honest guarantee: a process killed between the provider's 200 and the
    // settle leaves this row `sending`, and refusing it would be a notification nobody ever gets.
    const ledger = createMemoryDeliveryLedger();
    expect(await ledger.claim(claim, AT)).toBe(true);
    expect(await ledger.claim(claim, AT)).toBe(true);
    expect((await ledger.find(claim))?.attempts).toBe(2);
    expect((await ledger.find(claim))?.status).toBe('sending');
  });

  test('a failed delivery is re-claimable, so the job retry decides — not the ledger', async () => {
    const ledger = createMemoryDeliveryLedger();
    await ledger.claim(claim, AT);
    await ledger.settle(claim, 'failed', AT);
    expect(await ledger.claim(claim, AT)).toBe(true);
  });

  test('the four columns are one key, and none of them collides with a separator', async () => {
    const ledger = createMemoryDeliveryLedger();
    // `notifier:key` joined with a colon would read these two as the same delivery, and the loser
    // would be a notification that silently never arrives.
    await ledger.claim({ notifier: 'a:b', key: 'c', recipient: 'ana', channel: 'email' }, AT);
    await ledger.settle(
      { notifier: 'a:b', key: 'c', recipient: 'ana', channel: 'email' },
      'sent',
      AT,
    );
    expect(
      await ledger.claim({ notifier: 'a', key: 'b:c', recipient: 'ana', channel: 'email' }, AT),
    ).toBe(true);
  });

  test('a bulk claim is one row for the audience, distinct from every per-recipient one', async () => {
    const ledger = createMemoryDeliveryLedger();
    const bulk = { ...claim, recipient: null, channel: 'slack' };
    expect(await ledger.claim(bulk, AT)).toBe(true);
    await ledger.settle(bulk, 'sent', AT);
    expect(await ledger.claim(bulk, AT)).toBe(false);
    expect(await ledger.claim({ ...bulk, recipient: 'ana' }, AT)).toBe(true);
  });

  test('the cap evicts oldest-first and PUBLISHES the drop, because a dropped row stops deduping', async () => {
    const ledger = createMemoryDeliveryLedger({ max: 2 });
    for (const recipient of ['ana', 'ben', 'cyd']) {
      await ledger.claim({ ...claim, recipient }, AT);
    }
    expect(ledger.size).toBe(2);
    expect(ledger.dropped).toBe(1);
  });

  test('clear() empties the ledger AND its drop count, so one suite cannot pin the next', async () => {
    const ledger = createMemoryDeliveryLedger({ max: 1 });
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
