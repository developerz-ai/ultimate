// One claim: a `renew` that throws SYNCHRONOUSLY does not escape the timer.
//
// `void renew()` let it. `worker-fleet-slots.ts` guards the promise CHAIN with `.catch(noop)` and
// cannot guard this — `LeaseStore.renew` is an injected seam, and a store that throws on a closed
// pool throws on the call, before any chain exists. Nothing sits above a `setInterval` callback, so
// that throw is an uncaught exception thrown by the very timer that was keeping the lease alive.

import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { startRenewalTimer } from './renewal-timer';

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 2) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  expect.unreachable(`timed out waiting for ${label}`);
}

describe('unit · a renewal that raises', () => {
  test('a synchronous throw is caught, said out loud, and does not stop the interval', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const timer = startRenewalTimer(1, () => {
      calls += 1;
      // A `LeaseStore.renew` on a closed pool: the seam breaks its contract, on the call.
      throw new TypeError('the pool is closed');
    });

    try {
      await until(() => calls >= 2, 'the timer to survive its first throw');
      const raised = errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised');
      // Said out loud, because a lease that stops renewing with nothing anywhere saying so is the
      // silence this whole file exists to remove.
      expect(raised.length).toBeGreaterThanOrEqual(1);
      expect(raised[0]?.[1]).toEqual({ error: 'TypeError: the pool is closed' });
    } finally {
      timer.stop();
      errors.mockRestore();
    }
  });

  test('a rejected promise is caught the same way', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const timer = startRenewalTimer(1, () => {
      calls += 1;
      return Promise.reject(new TypeError('connection reset'));
    });

    try {
      await until(() => calls >= 2, 'the timer to survive its first rejection');
      const raised = errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised');
      expect(raised[0]?.[1]).toEqual({ error: 'TypeError: connection reset' });
    } finally {
      timer.stop();
      errors.mockRestore();
    }
  });

  test('a renewal that lands says nothing, and stop() is terminal', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const timer = startRenewalTimer(1, () => {
      calls += 1;
    });

    await until(() => calls >= 2, 'two clean renewals');
    timer.stop();
    expect(timer.stopped()).toBe(true);
    const seen = calls;
    await Bun.sleep(20);
    expect(calls).toBe(seen);
    expect(errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised')).toEqual([]);
    errors.mockRestore();
  });
});

describe('unit · the renewal interval never holds the process open', () => {
  test('the timer is unrefed, so an abandoned renewal cannot outlive the drain', () => {
    // A heartbeat or a fleet-slot renewal is registered from inside a job run, and a drain that
    // ABANDONS its hook leaves that run — and this interval — with nobody left to stop it. A
    // refed interval is then the one thing keeping a process the kubelet is waiting on alive,
    // until SIGKILL. `sync-node.ts` unrefs all three of its timers for the same reason.
    const real = globalThis.setInterval;
    let created: ReturnType<typeof setInterval> | undefined;
    const spy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      ms: number,
    ) => {
      created = real(handler, ms);
      return created;
    }) as unknown as typeof setInterval);

    try {
      const timer = startRenewalTimer(60_000, () => undefined);
      expect(created?.hasRef()).toBe(false);
      timer.stop();
    } finally {
      spy.mockRestore();
    }
  });
});
