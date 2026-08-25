// The dev ledger's two guarantees, neither of which `webhook.test.ts` can see: the ring is BOUNDED
// (a ledger that grows for the life of the process is a leak on the busiest path an app has), and
// the consecutive count is a counter rather than a scan of the ring — so an outage longer than the
// ring cannot make the number go DOWN, which is the direction that never disables anything.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { memoryWebhookLedger } from './webhook-ledger';

const attempt = (over: { ok: boolean; endpointId?: string; eventId?: string }) => ({
  webhook: 'partner-hooks',
  endpointId: over.endpointId ?? 'ep_1',
  eventId: over.eventId ?? 'evt_1',
  topic: 'orders.paid',
  attempt: 1,
  ok: over.ok,
  status: over.ok ? 200 : 500,
  at: 1_700_000_000_000,
  durationMs: 12,
});

describe('memoryWebhookLedger', () => {
  test('counts consecutive failures per endpoint and clears them on a success', async () => {
    const ledger = memoryWebhookLedger();
    expect(await ledger.record(attempt({ ok: false }))).toBe(1);
    expect(await ledger.record(attempt({ ok: false }))).toBe(2);
    // A second endpoint has its own run: one dead receiver must not disable a healthy one.
    expect(await ledger.record(attempt({ ok: false, endpointId: 'ep_2' }))).toBe(1);
    expect(await ledger.record(attempt({ ok: true }))).toBe(0);
    expect(await ledger.record(attempt({ ok: false }))).toBe(1);
  });

  test('the ring is bounded and the count survives eviction', async () => {
    const ledger = memoryWebhookLedger({ maxAttempts: 3 });
    for (let index = 0; index < 10; index += 1) {
      await ledger.record(attempt({ ok: false, eventId: `evt_${index}` }));
    }
    expect(ledger.attempts()).toHaveLength(3);
    // Newest last, oldest gone.
    expect(ledger.attempts().at(-1)?.eventId).toBe('evt_9');
    // Derived from a counter, never from the ring: a scan would answer 3 here and an endpoint that
    // has failed ten times running would look healthier the longer the outage lasted.
    expect(await ledger.record(attempt({ ok: false, eventId: 'evt_10' }))).toBe(11);
  });

  test('disable records the reason, and reset clears everything', async () => {
    const ledger = memoryWebhookLedger();
    await ledger.record(attempt({ ok: false }));
    await ledger.disable('ep_1', 'too many failures');
    expect(ledger.disabled().get('ep_1')).toBe('too many failures');

    ledger.reset();
    expect(ledger.attempts()).toHaveLength(0);
    expect(ledger.disabled().size).toBe(0);
    expect(await ledger.record(attempt({ ok: false }))).toBe(1);
  });

  test('a ring that holds nothing is refused where it is written', () => {
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        memoryWebhookLedger({ maxAttempts });
      } catch (error) {
        thrown = error;
      }
      expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT');
    }
  });

  test('the readers are copies, so a caller cannot edit the ledger through them', async () => {
    const ledger = memoryWebhookLedger();
    await ledger.record(attempt({ ok: false }));
    const snapshot = ledger.attempts();
    (snapshot as { length: number }).length = 0;
    expect(ledger.attempts()).toHaveLength(1);
  });
});
