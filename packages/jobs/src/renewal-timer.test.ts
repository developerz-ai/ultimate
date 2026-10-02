// One claim: a `renew` that throws SYNCHRONOUSLY does not escape the timer.
//
// `void renew()` let it. `worker-fleet-slots.ts` guards the promise CHAIN with `.catch(noop)` and
// cannot guard this — `LeaseStore.renew` is an injected seam, and a store that throws on a closed
// pool throws on the call, before any chain exists. Nothing sits above a timer callback, so that
// throw is an uncaught exception thrown by the very timer that was keeping the lease alive. Driven
// through the scheduler seam: no test here waits on the wall clock.

import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { type IntervalScheduler, startRenewalTimer } from './renewal-timer';

/** The seam a test hands in: nothing fires until the test says a tick happened. */
function manualScheduler(): IntervalScheduler & {
  tick(): void;
  readonly armed: () => number;
  readonly everyMs: () => number | undefined;
} {
  const ticks = new Set<() => void>();
  let every: number | undefined;
  const schedule = (tick: () => void, intervalMs: number): (() => void) => {
    every = intervalMs;
    ticks.add(tick);
    return () => {
      ticks.delete(tick);
    };
  };
  return Object.assign(schedule, {
    tick: () => {
      for (const tick of [...ticks]) tick();
    },
    armed: () => ticks.size,
    everyMs: () => every,
  });
}

/** Lets the renewal each tick queued settle — it runs in a `.then`, never on the tick itself. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('unit · a renewal that raises', () => {
  test('a synchronous throw is caught, said out loud, and does not stop the interval', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    const schedule = manualScheduler();
    let calls = 0;
    const timer = startRenewalTimer(
      1,
      () => {
        calls += 1;
        // A `LeaseStore.renew` on a closed pool: the seam breaks its contract, on the call.
        throw new TypeError('the pool is closed');
      },
      schedule,
    );

    try {
      schedule.tick();
      await settled();
      schedule.tick();
      await settled();
      expect(calls).toBe(2);
      const raised = errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised');
      // Said out loud, because a lease that stops renewing with nothing anywhere saying so is the
      // silence this whole file exists to remove.
      expect(raised.length).toBe(2);
      expect(raised[0]?.[1]).toEqual({ error: 'TypeError: the pool is closed' });
    } finally {
      timer.stop();
      errors.mockRestore();
    }
  });

  test('a rejected promise is caught the same way', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    const schedule = manualScheduler();
    const timer = startRenewalTimer(
      1,
      () => Promise.reject(new TypeError('connection reset')),
      schedule,
    );

    try {
      schedule.tick();
      await settled();
      const raised = errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised');
      expect(raised[0]?.[1]).toEqual({ error: 'TypeError: connection reset' });
    } finally {
      timer.stop();
      errors.mockRestore();
    }
  });

  test('a renewal that lands says nothing, and stop() is terminal', async () => {
    const errors = spyOn(logger, 'error').mockImplementation(() => undefined);
    const schedule = manualScheduler();
    let calls = 0;
    const timer = startRenewalTimer(
      1,
      () => {
        calls += 1;
      },
      schedule,
    );

    schedule.tick();
    schedule.tick();
    await settled();
    expect(calls).toBe(2);
    timer.stop();
    expect(timer.stopped()).toBe(true);
    // Disarmed, not merely ignored: a stopped renewal leaves nothing on the scheduler.
    expect(schedule.armed()).toBe(0);
    schedule.tick();
    await settled();
    expect(calls).toBe(2);
    expect(errors.mock.calls.filter((call) => call[0] === 'jobs.renewal.raised')).toEqual([]);
    errors.mockRestore();
  });
});

describe('unit · the scheduler is a seam', () => {
  test('an injected scheduler arms the renewal at its interval, and no real timer exists', () => {
    // The `runJobs` fixture renews on the test clock through this: a real interval there was a
    // renewal every millisecond of wall time for the length of every job test.
    const intervals = spyOn(globalThis, 'setInterval');
    const schedule = manualScheduler();
    try {
      const timer = startRenewalTimer(10_000, () => undefined, schedule);
      expect(schedule.armed()).toBe(1);
      expect(schedule.everyMs()).toBe(10_000);
      expect(intervals).not.toHaveBeenCalled();
      timer.stop();
    } finally {
      intervals.mockRestore();
    }
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
