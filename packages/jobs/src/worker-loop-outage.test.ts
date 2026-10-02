// The claim loop while every pass REJECTS — a database outage. A wake cuts the wait in hand to 0,
// and only `passed()` ever raised it again, which a failed pass never reaches. No wall clock: the
// loop's timers are the test's own, so a wait is a number asserted on, never time slept through.

import { afterEach, describe, expect, test } from 'bun:test';
import { setWakeLive, signalEnqueued } from './enqueue-signal';
import type { ClaimLoop, LoopTimers } from './worker-loop';
import { createClaimLoop } from './worker-loop';

const FLOOR_MS = 250;

/** Every wait the loop armed, in order, and the one in hand — fired by the test, never by time. */
function manualTimers(): LoopTimers & { readonly waits: number[]; fire(): void } {
  let armed: { readonly run: () => void } | undefined;
  const waits: number[] = [];
  return {
    waits,
    set(run, ms) {
      armed = { run };
      waits.push(ms);
      return armed;
    },
    clear(handle) {
      if (armed === handle) armed = undefined;
    },
    fire() {
      const current = armed;
      if (current === undefined) expect.unreachable('the loop has no wait armed');
      armed = undefined;
      current?.run();
    },
  };
}

/** The pass's `.catch().finally()` chain, run to its end: macrotask order, not elapsed time. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let loop: ClaimLoop | undefined;

afterEach(() => {
  loop?.stop();
  loop = undefined;
  setWakeLive(false);
});

function outage(round: () => Promise<unknown>) {
  const timers = manualTimers();
  const errors: unknown[] = [];
  loop = createClaimLoop({
    subject: 'the test loop',
    floorMs: FLOOR_MS,
    queues: ['default'],
    round,
    onError: (error) => errors.push(error),
    timers,
  });
  loop.start();
  return { timers, errors, loop };
}

describe('the claim loop during an outage', () => {
  test('one wake while every pass rejects costs ONE immediate pass, then the floor again', async () => {
    let rounds = 0;
    const { timers, errors } = outage(() => {
      rounds += 1;
      return Promise.reject(new Error('the pool is down'));
    });
    timers.fire();
    await settled();
    signalEnqueued('default');
    for (let pass = 0; pass < 6; pass += 1) {
      timers.fire();
      await settled();
    }
    expect(rounds).toBe(7);
    expect(errors).toHaveLength(7);
    // The floor, the failed pass's re-arm, the wake's 0 — and then never 0 again. It was 0 for
    // every wait after the wake: 452 passes in 500 ms from a 250 ms floor.
    expect(timers.waits).toEqual([FLOOR_MS, FLOOR_MS, 0, ...Array(6).fill(FLOOR_MS)]);
  });

  test('a wake landing ON a failing pass asks for one more, and that one re-arms at the floor', async () => {
    let fail: (error: unknown) => void = () => undefined;
    const { timers, loop: running } = outage(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    timers.fire();
    signalEnqueued('default');
    fail(new Error('the pool is down'));
    await settled();
    expect(timers.waits).toEqual([FLOOR_MS, 0]);
    timers.fire();
    fail(new Error('the pool is still down'));
    await settled();
    expect(timers.waits).toEqual([FLOOR_MS, 0, FLOOR_MS]);
    expect(running.delayMs()).toBe(FLOOR_MS);
  });

  test('a backed-off loop whose pass fails retries at the floor, not at the idle wait', async () => {
    let down = false;
    const { timers, loop: running } = outage(() => {
      if (down) return Promise.reject(new Error('the pool is down'));
      running.passed(false);
      return Promise.resolve();
    });
    for (let pass = 0; pass < 4; pass += 1) {
      timers.fire();
      await settled();
    }
    expect(running.delayMs()).toBeGreaterThan(FLOOR_MS);
    down = true;
    timers.fire();
    await settled();
    expect(timers.waits.at(-1)).toBe(FLOOR_MS);
  });
});
