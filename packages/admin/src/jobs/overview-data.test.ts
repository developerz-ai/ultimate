// The overview's arithmetic, without a queue: counter buckets of any tier summed into fixed bars,
// per-name volume, failure rate and mean, the one URL parameter the overview reads — and how many
// reads one visit costs on an app with a hundred job names.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  type CounterBucketMs,
  type JobCounter,
  type JobDriver,
  type JobIntrospection,
  memoryJobDriver,
} from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import {
  barsOf,
  DEFAULT_RANGE,
  nameRowsOf,
  OVERVIEW_RANGES,
  overviewData,
  rangeOf,
} from './overview-data';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

const bucket = (
  minutesAgo: number,
  counts: Partial<JobCounter>,
  bucketMs: CounterBucketMs = 60_000,
): JobCounter => ({
  job: 'send',
  bucketStart: NOW - minutesAgo * 60_000,
  bucketMs,
  done: 0,
  retried: 0,
  failed: 0,
  dead: 0,
  durationMs: 0,
  ...counts,
});

describe('barsOf', () => {
  test('a fixed number of equal bars per range, oldest first, done apart from failed and dead', () => {
    const bars = barsOf(
      [
        bucket(59, { done: 2 }),
        bucket(58, { failed: 1, dead: 1, retried: 9 }),
        bucket(1, { done: 5 }),
      ],
      '1h',
      NOW,
    );
    expect(bars).toHaveLength(OVERVIEW_RANGES['1h'].bars);
    expect(bars[0]).toEqual({ startMs: NOW - 3_600_000, done: 2, failed: 2 });
    // A retried attempt is not an ending: it is in neither series.
    expect(bars.at(-1)).toMatchObject({ done: 5, failed: 0 });
  });

  test('a bucket outside the window lands on the nearest edge rather than vanishing', () => {
    const bars = barsOf([bucket(90, { done: 1 }), bucket(-5, { done: 3 })], '1h', NOW);
    expect(bars[0]?.done).toBe(1);
    expect(bars.at(-1)?.done).toBe(3);
  });
});

describe('nameRowsOf', () => {
  test('volume, the share that ended badly, and the mean over every attempt', () => {
    expect(
      nameRowsOf([{ job: 'send', done: 3, retried: 1, failed: 0, dead: 1, durationMs: 500 }]),
    ).toEqual([{ name: 'send', volume: 4, failureRate: 0.25, meanMs: 100 }]);
  });

  test('a name with nothing ended has no rate and no mean, never a division by zero', () => {
    expect(
      nameRowsOf([{ job: 'idle', done: 0, retried: 0, failed: 0, dead: 0, durationMs: 0 }]),
    ).toEqual([{ name: 'idle', volume: 0, failureRate: null, meanMs: null }]);
  });
});

describe('rangeOf', () => {
  test('one of four, the default when absent, and anything else refused by name', () => {
    expect(rangeOf(new URL('http://x/jobs'))).toBe(DEFAULT_RANGE);
    expect(rangeOf(new URL('http://x/jobs?range='))).toBe(DEFAULT_RANGE);
    expect(rangeOf(new URL('http://x/jobs?range=7d'))).toBe('7d');
    try {
      rangeOf(new URL('http://x/jobs?range=forever'));
      expect.unreachable('an unknown range was accepted');
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('not a framework refusal');
      expect(error.code).toBe('X_ADMIN_FILTER_INVALID');
      expect(error.cause).toContain('range=30d');
    }
  });
});

/** A memory queue with `names` job names, each settled once, its reads counted by member. */
async function countedQueue(names: number, batched: boolean): Promise<Map<string, number>> {
  const driver = memoryJobDriver();
  const operator = driver.introspect;
  if (operator === undefined) return expect.unreachable('the memory driver ships introspection');
  for (let index = 0; index < names; index += 1) {
    const name = `overview-name-${index}`;
    const { id } = await driver.enqueue({
      name,
      queue: 'default',
      input: {},
      idempotencyKey: name,
      maxAttempts: 1,
    });
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    await driver.ack(id, { workerId: 'w', claim: 1, durationMs: 2 });
  }
  const calls = new Map<string, number>();
  const counted = <T extends (...args: never[]) => unknown>(member: string, fn: T): T =>
    ((...args: Parameters<T>) => {
      calls.set(member, (calls.get(member) ?? 0) + 1);
      return fn(...args);
    }) as T;
  const { countersMany, ...rest } = operator;
  const introspect: JobIntrospection = {
    ...rest,
    workers: counted('workers', operator.workers),
    counterTotals: counted('counterTotals', operator.counterTotals),
    counters: counted('counters', operator.counters),
    ...(batched && countersMany !== undefined
      ? { countersMany: counted('countersMany', countersMany) }
      : {}),
  };
  const wrapped: JobDriver = { ...driver, stats: counted('stats', driver.stats), introspect };
  installJobDriver(wrapped);
  return calls;
}

describe('overviewData', () => {
  afterEach(() => resetJobDriver());

  test('a hundred settled job names are read in a fixed number of statements, not one per name', async () => {
    const calls = await countedQueue(100, true);
    const data = await overviewData('24h', Date.now());
    expect(data.names).toHaveLength(100);
    expect(data.bars.reduce((sum, bar) => sum + bar.done, 0)).toBe(100);
    expect(calls.get('counters')).toBeUndefined();
    expect(calls.get('countersMany')).toBe(1);
    const reads = [...calls.values()].reduce((sum, count) => sum + count, 0);
    expect(reads).toBeLessThanOrEqual(4);
  });

  test('a driver without countersMany is still drawn, one counters read per name', async () => {
    const calls = await countedQueue(3, false);
    const data = await overviewData('24h', Date.now());
    expect(data.bars.reduce((sum, bar) => sum + bar.done, 0)).toBe(3);
    expect(calls.get('counters')).toBe(3);
  });
});
