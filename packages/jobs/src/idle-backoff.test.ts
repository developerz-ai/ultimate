// `restAfter` refuses a non-finite declared ceiling instead of letting `NaN` through `??`; a loop
// settles only once the wake slot it was woken in has passed, whatever its floor.

import { describe, expect, test } from 'bun:test';
import { WAKE_SLOT_MS } from './driver-pg-wake-sql';
import { createIdleBackoff, restAfter } from './idle-backoff';

const pass = {
  found: false,
  dueInMs: null,
  backoffMs: 1_000,
  floorMs: 250,
  settled: true,
  announced: true,
} as const;

describe('restAfter', () => {
  test('a NaN declared ceiling is refused, not propagated into the delay', () => {
    expect(() => restAfter({ ...pass, declaredCeilingMs: Number.NaN })).toThrow(/idlePollMaxMs/);
  });

  test('a finite declared ceiling still bounds the rest', () => {
    expect(() => restAfter({ ...pass, declaredCeilingMs: 5_000 })).not.toThrow();
  });
});

describe('settled', () => {
  /** Passes a loop makes after a wake, each one floor-or-backoff behind the last, all empty. */
  function settledAfter(floorMs: number): { passes: number; elapsedMs: number } {
    let at = 0;
    const backoff = createIdleBackoff({ subject: 'test', floorMs });
    backoff.reset(); // the wake: its row's slot ends at most `WAKE_SLOT_MS` from here
    for (let passes = 1; passes <= 50; passes += 1) {
      const delay = backoff.next(false);
      if (backoff.settled()) return { passes, elapsedMs: at };
      at += delay; // the loop waits what it was handed
    }
    return expect.unreachable('the loop never settled');
  }

  test('a floor of a slot or more settles on the second empty pass, as it always did', () => {
    expect(settledAfter(WAKE_SLOT_MS)).toEqual({ passes: 2, elapsedMs: WAKE_SLOT_MS });
    expect(settledAfter(1_000).passes).toBe(2);
  });

  test('a floor below a slot does not settle until the wake slot has passed', () => {
    // Two passes 25 ms apart used to count as settled: the row its slot left silent, committed
    // 60 ms after the wake, then waited out the whole rest (`IDLE_REST_MAX_MS`).
    for (const floorMs of [0, 25, 100, 200]) {
      expect(settledAfter(floorMs).elapsedMs).toBeGreaterThanOrEqual(WAKE_SLOT_MS);
    }
  });

  test('found work restarts the count, like a wake', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 25 });
    for (let pass = 0; pass < 10; pass += 1) backoff.next(false);
    expect(backoff.settled()).toBe(true);
    backoff.next(true);
    backoff.next(false);
    backoff.next(false);
    expect(backoff.settled()).toBe(false);
  });

  test('an in-flight hint (`dueInMs` 0) never rests, even settled', () => {
    expect(restAfter({ ...pass, dueInMs: 0 })).toEqual({ delayMs: 1_000, resting: false });
  });
});
