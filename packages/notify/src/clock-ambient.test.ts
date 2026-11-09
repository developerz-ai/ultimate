// One clock: a delivery attempt under a context built with no clock (as a job's is) records the
// installed clock's instant in the ledger — `installClock` reaches every notify "now" via `ctx.now()`.

import { expect, test } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { attemptDelivery } from './attempt';
import { memoryDeliveryLedger } from './ledger';

test('a default context stamps the installed clock on the delivery ledger', async () => {
  const ledger = memoryDeliveryLedger();
  const claim = { notifier: 'clock.probe', key: 'k1', recipient: 'ana', channel: 'email' };
  const release = installClock(frozenClock('2001-02-03T04:05:06Z'));
  try {
    const ctx = ctxOf({});
    const input = { ledger, claim, notifier: 'clock.probe', channel: 'email', recipients: 1, ctx };
    await attemptDelivery({ ...input, send: () => undefined }, new AbortController().signal);
    expect((await ledger.find(claim))?.at.toISOString()).toBe('2001-02-03T04:05:06.000Z');
  } finally {
    release();
  }
});
