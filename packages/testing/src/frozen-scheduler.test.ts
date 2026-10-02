// A renewal on the frozen clock fires when a test moves time past it, once per move, and never on
// the wall clock — the property the `runJobs` fixture's cancel path stands on.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  advanceClock,
  captureDeterminism,
  restoreCapturedDeterminism,
  setFrozenClock,
} from './determinism';
import { frozenScheduler } from './frozen-scheduler';
import { testName } from './test-types';

const captured = captureDeterminism();
afterEach(() => restoreCapturedDeterminism(captured));

describe(testName('unit', 'frozenScheduler: ticks when the test moves time'), () => {
  test('nothing fires until the clock passes the interval, then once per move', () => {
    using timers = frozenScheduler();
    let ticks = 0;
    timers.schedule(() => {
      ticks += 1;
    }, 10);

    advanceClock(9);
    expect(ticks).toBe(0);
    advanceClock(1);
    expect(ticks).toBe(1);
    // A three-day jump is one renewal, not a replay of every interval it skipped.
    advanceClock(3 * 86_400_000);
    expect(ticks).toBe(2);
    // Re-armed from the instant it fired: the next is due one interval later.
    advanceClock(9);
    expect(ticks).toBe(2);
  });

  test('setting the clock is a move too', () => {
    using timers = frozenScheduler();
    let ticks = 0;
    timers.schedule(() => {
      ticks += 1;
    }, 1_000);
    setFrozenClock('2030-01-01T00:00:00.000Z');
    expect(ticks).toBe(1);
  });

  test('a cancelled tick and a disposed scheduler hear nothing', () => {
    let ticks = 0;
    const timers = frozenScheduler();
    const cancel = timers.schedule(() => {
      ticks += 1;
    }, 1);
    expect(timers.armed()).toBe(1);
    cancel();
    expect(timers.armed()).toBe(0);
    advanceClock(5);
    expect(ticks).toBe(0);

    timers.schedule(() => {
      ticks += 1;
    }, 1);
    timers[Symbol.dispose]();
    advanceClock(5);
    expect(ticks).toBe(0);
  });
});
