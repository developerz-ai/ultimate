// What an idle scheduler costs: the level an on-time fire logs at, and how often the leader folds
// the counters when there is nothing old enough to fold. Fake clock, memory driver.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver } from './scheduler';
import {
  COUNTER_ROLLUP_IDLE_INTERVAL_MS,
  COUNTER_ROLLUP_INTERVAL_MS,
  jobScheduler,
} from './scheduler';
import { memorySchedulerState } from './scheduler-state';
import { resetTasks, task } from './task';

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const hourly: CronResolver = (_cron, options) => {
  const from = options.from.getTime();
  return new Date(Math.floor(from / 3_600_000) * 3_600_000 + 3_600_000);
};

const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

const events = (spy: { mock: { calls: readonly (readonly unknown[])[] } }): readonly unknown[] =>
  spy.mock.calls.map((call) => call[0]);

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
  const digest = job<Record<string, never>>({
    tenant: 'none',
    name: 'cadenceDigest',
    input: passthrough,
    idempotencyKey: () => 'digest',
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
  task({ name: 'cadenceTask', cron: '0 * * * *', tz: 'UTC', enqueue: () => [[digest, {}]] });
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe('scheduler log levels', () => {
  test('an on-time fire is debug; a catch-up fire stays info', async () => {
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const scheduler = jobScheduler({ driver, clock, cron: hourly, state: memorySchedulerState() });
    const info = spyOn(logger, 'info');
    const debug = spyOn(logger, 'debug');
    try {
      await scheduler.tick(); // Arms it for 01:00.
      clock.advance(3_600_000 + 1_000);
      expect((await scheduler.tick())[0]?.catchUp).toBe(false);
      expect(events(debug)).toContain('jobs.scheduler.dispatched');
      expect(events(info)).not.toContain('jobs.scheduler.dispatched');

      debug.mockClear();
      clock.advance(3 * 3_600_000); // Three occurrences owed: a catch-up.
      expect((await scheduler.tick()).some((fire) => fire.catchUp)).toBe(true);
      expect(events(info)).toContain('jobs.scheduler.dispatched');
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });
});

describe('scheduler counter fold cadence', () => {
  test('a fold that moved nothing waits the idle interval; one that moved waits the short one', async () => {
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const operator = driver.introspect;
    if (operator === undefined) return expect.unreachable('the memory driver has an operator');
    let moved = 0;
    const fold = spyOn(operator, 'rollupCounters').mockImplementation(() => Promise.resolve(moved));
    const scheduler = jobScheduler({ driver, clock, cron: hourly, state: memorySchedulerState() });

    await scheduler.tick();
    expect(fold).toHaveBeenCalledTimes(1);
    // Nothing was old enough: the short interval is not enough to ask again.
    clock.advance(COUNTER_ROLLUP_INTERVAL_MS);
    await scheduler.tick();
    expect(fold).toHaveBeenCalledTimes(1);
    clock.advance(COUNTER_ROLLUP_IDLE_INTERVAL_MS - COUNTER_ROLLUP_INTERVAL_MS);
    moved = 4;
    await scheduler.tick();
    expect(fold).toHaveBeenCalledTimes(2);
    // It moved buckets: more may be just past the line, so the short interval again.
    clock.advance(COUNTER_ROLLUP_INTERVAL_MS);
    await scheduler.tick();
    expect(fold).toHaveBeenCalledTimes(3);
  });

  test('a fold that failed is retried on the short interval, not the idle one', async () => {
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const operator = driver.introspect;
    if (operator === undefined) return expect.unreachable('the memory driver has an operator');
    const warn = spyOn(logger, 'warn');
    const fold = spyOn(operator, 'rollupCounters').mockImplementation(() =>
      Promise.reject(new TypeError('pool closed')),
    );
    try {
      const scheduler = jobScheduler({
        driver,
        clock,
        cron: hourly,
        state: memorySchedulerState(),
      });
      await scheduler.tick();
      clock.advance(COUNTER_ROLLUP_INTERVAL_MS);
      await scheduler.tick();
      expect(fold).toHaveBeenCalledTimes(2);
      expect(events(warn)).toContain('jobs.scheduler.rollup-failed');
    } finally {
      warn.mockRestore();
    }
  });
});
