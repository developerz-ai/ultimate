// The operator surface on the memory driver: the shared scenarios under an INJECTED clock, plus
// what needs no second driver to prove — the counters' fold, progress throttling, the
// trace an operator opens, and a paused task.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, logger, redactKeys } from '@ultimat3/core';
import { counterBucketStart, createMemoryCounters } from './counters';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { inspectJob } from './inspect';
import { promoteJob } from './inspect-operator';
import { COUNTER_TIERS, PROGRESS_INTERVAL_MS } from './introspection';
import { resetJobs } from './job';
import type { OperatorHarness } from './operator-surface-fixture';
import {
  enqueueItem,
  itemJob,
  memorySchedulerState,
  operatorOf,
  operatorSurfaceScenarios,
  workerOn,
} from './operator-surface-fixture';
import { operatorScopeScenarios } from './operator-surface-scope-fixture';
import { operatorSettleScenarios } from './operator-surface-settle-fixture';
import { createProgressReporter } from './progress';
import { COUNTER_ROLLUP_INTERVAL_MS, jobScheduler, PAUSE_RECHECK_MS } from './scheduler';
import { resetTasks, task } from './task';

const clock = frozenClock('2026-10-01T00:00:30.000Z');

const harness: OperatorHarness = {
  clock,
  driver: () => Promise.resolve(memoryJobDriver({ clock })),
  elapse: (_driver, ms) => {
    clock.advance(ms);
    return Promise.resolve();
  },
  // Straight through the queue: enqueue, claim, settle — the states a real run leaves.
  async seed(driver, { name, state, count, queue = 'default' }) {
    for (let index = 0; index < count; index += 1) {
      const { id } = await driver.enqueue({
        name,
        queue,
        input: { item: `seed-${index}` },
        idempotencyKey: `seed:${name}:${state}:${index}`,
        maxAttempts: 1,
      });
      await driver.claim({ queues: [queue], limit: 1, visibilityTimeoutMs: 30_000, workerId: 's' });
      if (state === 'done') await driver.ack(id, { workerId: 's', claim: 1 });
      else
        await driver.nack(id, {
          workerId: 's',
          claim: 1,
          delayMs: 0,
          deadLetter: state === 'dead',
        });
      clock.advance(1);
    }
  },
  schedulerState: () => Promise.resolve(memorySchedulerState()),
};

afterEach(() => {
  resetJobs();
  resetTasks();
});

describe('the operator surface', () => {
  operatorSurfaceScenarios('memory', harness);
  operatorSettleScenarios('memory', harness);
  operatorScopeScenarios('memory', harness);
});

describe('counter buckets age into wider ones', () => {
  test('a bucket past its tier folds into the next, and past the last tier it is dropped', () => {
    const counters = createMemoryCounters();
    const [minute, five, hour] = COUNTER_TIERS;
    const at = Date.UTC(2026, 9, 1, 12, 0, 30);
    counters.add('sync', 'done', 40, at);
    counters.add('sync', 'done', 60, at + 61_000);
    counters.add('sync', 'dead', 5, at + 61_000);

    // Inside the first tier nothing moves.
    expect(counters.rollup(at + minute.keepMs - 60_000)).toBe(0);
    // Past it, both one-minute buckets land in the ONE five-minute bucket that contains them.
    expect(counters.rollup(at + minute.keepMs + 120_000)).toBe(2);
    expect(counters.list({ job: 'sync', sinceMs: 0 })).toEqual([
      {
        job: 'sync',
        bucketMs: five.bucketMs,
        bucketStart: counterBucketStart(at, five.bucketMs),
        done: 2,
        retried: 0,
        failed: 0,
        dead: 1,
        durationMs: 105,
      },
    ]);
    // The totals never moved: a fold changes the resolution, not the count.
    expect(counters.totals(0)).toEqual([
      { job: 'sync', done: 2, retried: 0, failed: 0, dead: 1, durationMs: 105 },
    ]);

    expect(counters.rollup(at + five.keepMs + 600_000)).toBe(1);
    expect(counters.list({ job: 'sync', sinceMs: 0 })[0]?.bucketMs).toBe(hour.bucketMs);
    expect(counters.rollup(at + hour.keepMs + 7_200_000)).toBe(1);
    expect(counters.list({ job: 'sync', sinceMs: 0 })).toEqual([]);
  });

  test('the scheduler leader folds them, at most once every ten minutes', async () => {
    const driver = memoryJobDriver({ clock });
    const operator = operatorOf(driver);
    let folds = 0;
    const counting: JobDriver = {
      ...driver,
      introspect: {
        ...operator,
        rollupCounters: () => {
          folds += 1;
          return operator.rollupCounters();
        },
      },
    };
    const scheduler = jobScheduler({ driver: counting, clock, tasks: [] });

    await scheduler.tick();
    await scheduler.tick();
    expect(folds).toBe(1);
    clock.advance(COUNTER_ROLLUP_INTERVAL_MS - 1_000);
    await scheduler.tick();
    expect(folds).toBe(1);
    clock.advance(1_000);
    await scheduler.tick();
    expect(folds).toBe(2);
  });
});

describe('progress', () => {
  test('is written at most once an interval, and the last value always lands', async () => {
    const writes: number[] = [];
    const reporter = createProgressReporter({
      job: 'sync',
      jobId: 'job-1',
      clock,
      write: (value) => {
        writes.push(value.done);
        return Promise.resolve();
      },
    });

    /** A write is chained on a promise, so it lands a turn after the call that started it. */
    const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    for (let done = 1; done <= 500; done += 1) reporter.report(done, 1_000);
    await turn();
    // One write: the first. 499 more calls inside the interval cost nothing.
    expect(writes).toEqual([1]);
    clock.advance(PROGRESS_INTERVAL_MS);
    reporter.report(501, 1_000);
    reporter.report(502, 1_000, 'x'.repeat(500));
    await turn();
    expect(writes).toEqual([1, 501]);

    await reporter.flush();
    expect(writes).toEqual([1, 501, 502]);
    // Flushed once: nothing is pending, so a second flush writes nothing.
    await reporter.flush();
    expect(writes).toEqual([1, 501, 502]);
    // A count that is not a number is not progress.
    reporter.report(Number.NaN, 1_000);
    await reporter.flush();
    expect(writes).toEqual([1, 501, 502]);
  });

  test('a write that fails is logged and never fails the run', async () => {
    const warned = spyOn(logger, 'warn');
    const reporter = createProgressReporter({
      job: 'sync',
      jobId: 'job-1',
      clock,
      write: () => Promise.reject(new TypeError('pool closed')),
    });
    reporter.report(1, 2);
    await reporter.flush();
    const lines = warned.mock.calls.filter((call) => call[0] === 'jobs.progress.failed');
    warned.mockRestore();
    expect(lines).toHaveLength(1);
  });

  test('a body`s last report is on the row when the run has settled', async () => {
    const driver = memoryJobDriver({ clock });
    const handle = itemJob({
      run: ({ progress }) => {
        progress(1, 3);
        progress(2, 3);
        progress(3, 3, 'all rows');
        return Promise.resolve();
      },
    });
    const id = await enqueueItem(driver, handle);
    await workerOn(harness, driver, 'worker-a').tick();

    const trace = await inspectJob(driver, id);
    expect(trace?.state).toBe('done');
    expect(trace?.progress).toMatchObject({ done: 3, total: 3, note: 'all rows' });
  });
});

describe('the trace an operator opens', () => {
  test('carries the payload with declared secrets redacted, and the failure`s stack', async () => {
    redactKeys(['operatorSurfaceApiToken']);
    const driver = memoryJobDriver({ clock });
    const handle = itemJob({ run: () => Promise.reject(new TypeError('selector moved')) });
    const { id } = await driver.enqueue({
      name: handle.name,
      queue: 'default',
      input: { item: 'a', operatorSurfaceApiToken: 'sk-live-1', nested: [{ password: 'hunter2' }] },
      idempotencyKey: 'trace:1',
      maxAttempts: 1,
    });
    await workerOn(harness, driver, 'worker-a').tick();

    const trace = await inspectJob(driver, id);
    expect(trace?.input).toEqual({
      item: 'a',
      operatorSurfaceApiToken: '[redacted]',
      nested: [{ password: '[redacted]' }],
    });
    expect(trace?.stack).toContain('TypeError: selector moved');
    expect(trace?.stack).toContain('operator-surface.test.ts');
    expect(trace?.progress).toBeNull();
  });

  test('promoteJob names the state of a job that is not waiting on its run time', async () => {
    const driver = memoryJobDriver({ clock });
    const handle = itemJob({ run: () => Promise.resolve() });
    const id = await enqueueItem(driver, handle);
    const refusal = await promoteJob(driver, id).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: 'X_JOB_NOT_PROMOTABLE',
      fix: `x jobs show ${id} --json`,
    });
    expect((refusal as { cause: string }).cause).toContain('is ready');
  });
});

describe('a paused task', () => {
  test('is not dispatched, and on resume its own catch-up policy decides what it missed', async () => {
    const driver = memoryJobDriver({ clock });
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const hourly = task({
      name: 'operator-hourly',
      cron: '0 * * * *',
      tz: 'UTC',
      catchUp: 'skip',
      enqueue: () => [[handle, { item: 'tick' }]],
    });
    const everyHour = (_cron: string, options: { from: Date }): Date =>
      new Date(Math.floor(options.from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
    const scheduler = jobScheduler({ driver, clock, cron: everyHour, tasks: [hourly] });
    await scheduler.tick();

    await operator.pauseTask('operator-hourly');
    clock.advance(3 * 3_600_000);
    expect(await scheduler.tick()).toEqual([]);
    expect(await operator.list({ name: handle.name })).toEqual([]);

    await operator.resumeTask('operator-hourly');
    // A task found paused is looked at again after `PAUSE_RECHECK_MS`, never every round.
    expect(await scheduler.tick()).toEqual([]);
    clock.advance(PAUSE_RECHECK_MS);
    // `skip`: ONE dispatch, for the latest occurrence the pause missed — as after an outage.
    const dispatched = await scheduler.tick();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.catchUp).toBe(true);
    expect(await operator.list({ name: handle.name })).toHaveLength(1);
  });
});
