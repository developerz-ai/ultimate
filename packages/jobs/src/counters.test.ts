// The per-job counters' arithmetic, on the memory store: which outcome a nack adds, one bucket per
// minute, totals per job in name order, and a rollup that folds an aged bucket into the next tier —
// and drops it past the last.

import { describe, expect, test } from 'bun:test';
import { counterBucketStart, memoryCounters, nackOutcome } from './counters';
import { COUNTER_TIERS } from './introspection';

const by = { workerId: 'w', claim: 1 };
const MINUTE = 60_000;
const FIVE = 300_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('nackOutcome', () => {
  test('dead and failed are history; a counted retry is retried; a hand-back is nothing', () => {
    expect(nackOutcome({ ...by, delayMs: 0, deadLetter: true })).toBe('dead');
    expect(nackOutcome({ ...by, delayMs: 0, fail: true })).toBe('failed');
    expect(nackOutcome({ ...by, delayMs: 0 })).toBe('retried');
    expect(nackOutcome({ ...by, delayMs: 0, countsAsAttempt: false })).toBeUndefined();
    expect(nackOutcome({ ...by, delayMs: 0, park: true, countsAsAttempt: false })).toBeUndefined();
  });
});

describe('memoryCounters', () => {
  test('a settle lands in its minute, summed with the others there', () => {
    const counters = memoryCounters();
    counters.add('mail', 'done', 10, 5 * MINUTE + 1);
    counters.add('mail', 'done', 30, 5 * MINUTE + 59_999);
    counters.add('mail', 'failed', 5, 6 * MINUTE);
    expect(counters.list({ job: 'mail', sinceMs: 0 })).toEqual([
      {
        job: 'mail',
        bucketMs: MINUTE,
        bucketStart: 5 * MINUTE,
        done: 2,
        retried: 0,
        failed: 0,
        dead: 0,
        durationMs: 40,
      },
      {
        job: 'mail',
        bucketMs: MINUTE,
        bucketStart: 6 * MINUTE,
        done: 0,
        retried: 0,
        failed: 1,
        dead: 0,
        durationMs: 5,
      },
    ]);
    expect(counters.list({ job: 'mail', sinceMs: 6 * MINUTE })).toHaveLength(1);
    expect(counters.list({ job: 'other', sinceMs: 0 })).toEqual([]);
  });

  test('totals are per job, in name order, from the instant asked', () => {
    const counters = memoryCounters();
    counters.add('zeta', 'dead', 1, MINUTE);
    counters.add('alpha', 'retried', 2, MINUTE);
    counters.add('mid', 'done', 3, 0);
    counters.add('alpha', 'done', 4, 2 * MINUTE);
    expect(counters.totals(MINUTE)).toEqual([
      { job: 'alpha', done: 1, retried: 1, failed: 0, dead: 0, durationMs: 6 },
      { job: 'zeta', done: 0, retried: 0, failed: 0, dead: 1, durationMs: 1 },
    ]);
  });

  test('rollup folds an aged minute into its five-minute bucket, keeping the counts', () => {
    expect(COUNTER_TIERS.map((tier) => tier.bucketMs)).toEqual([MINUTE, FIVE, HOUR]);
    const counters = memoryCounters();
    counters.add('mail', 'done', 10, 1 * MINUTE);
    counters.add('mail', 'done', 20, 3 * MINUTE);
    counters.add('mail', 'done', 5, DAY + MINUTE);
    // A day and four minutes on: the two early minutes are past the minute tier's day.
    expect(counters.rollup(DAY + 4 * MINUTE)).toBe(2);
    expect(counters.list({ job: 'mail', sinceMs: 0 })).toEqual([
      {
        job: 'mail',
        bucketMs: FIVE,
        bucketStart: 0,
        done: 2,
        retried: 0,
        failed: 0,
        dead: 0,
        durationMs: 30,
      },
      {
        job: 'mail',
        bucketMs: MINUTE,
        bucketStart: DAY + MINUTE,
        done: 1,
        retried: 0,
        failed: 0,
        dead: 0,
        durationMs: 5,
      },
    ]);
    // Nothing else has aged: a second pass at the same instant moves nothing.
    expect(counters.rollup(DAY + 4 * MINUTE)).toBe(0);
  });

  test('a bucket past the last tier is dropped, not kept forever', () => {
    const counters = memoryCounters();
    counters.add('mail', 'done', 1, 0);
    const last = COUNTER_TIERS[COUNTER_TIERS.length - 1];
    if (last === undefined) return expect.unreachable('a counter tier exists');
    // Far enough on that every tier's keep has passed: minute → 5m → hour → gone.
    expect(counters.rollup(last.keepMs + HOUR)).toBe(3);
    expect(counters.list({ job: 'mail', sinceMs: 0 })).toEqual([]);
  });

  test('counterBucketStart floors to the bucket', () => {
    expect(counterBucketStart(HOUR + 59 * MINUTE, HOUR)).toBe(HOUR);
    expect(counterBucketStart(FIVE - 1, FIVE)).toBe(0);
  });
});
