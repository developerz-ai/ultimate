// The `queue_depth` gauge `docker/helm`'s worker HPA scales on. The worker is the only process
// that reads its own queue, so it is the only thing that can publish the number — and it must
// publish it without letting the read cost a tick or repeat itself sixty times a scrape.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import {
  collectMetrics,
  configureErrorReporting,
  createContext,
  memoryErrorReporter,
  resetErrorReporting,
  resetMetrics,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver, QueueStats } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const queue = (name: string, ready: number): QueueStats => ({
  queue: name,
  ready,
  delayed: 0,
  running: 0,
  suspended: 0,
  dead: 0,
  oldestReadyMs: 0,
});

interface CountingDriver {
  readonly driver: JobDriver;
  calls(): { stats: number; claim: number };
}

/** The memory driver's real `steps` store with the two methods under test swapped out. */
function countingDriver(stats: () => Promise<readonly QueueStats[]>): CountingDriver {
  let statsCalls = 0;
  let claimCalls = 0;
  const base = createMemoryDriver();
  return {
    driver: {
      ...base,
      async stats(): Promise<readonly QueueStats[]> {
        statsCalls += 1;
        return await stats();
      },
      async claim(): Promise<readonly ClaimedJob[]> {
        claimCalls += 1;
        return [];
      },
    },
    calls: () => ({ stats: statsCalls, claim: claimCalls }),
  };
}

const depthOf = (name: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'queue_depth')
    ?.points.find((point) => point.attributes['queue'] === name)?.value;

const worker = (driver: JobDriver) =>
  createWorker({ driver, context: () => createContext({ role: 'worker', buildId: 'test' }) });

beforeEach(() => {
  resetMetrics();
});

describe('the worker publishes queue depth', () => {
  test('one series per queue the driver reports, labelled by queue', async () => {
    const counting = countingDriver(async () => [queue('default', 41), queue('emails', 7)]);
    await worker(counting.driver).tick();

    expect(depthOf('default')).toBe(41);
    // Every queue, not only the ones this process serves: depth is the queue's fact, and a queue
    // no pod published is a queue no autoscaler can see.
    expect(depthOf('emails')).toBe(7);
  });

  test('claimable only — a job parked until Tuesday is not backlog', async () => {
    const counting = countingDriver(async () => [
      { ...queue('default', 2), delayed: 900, suspended: 40, dead: 5 },
    ]);
    await worker(counting.driver).tick();

    expect(depthOf('default')).toBe(2);
  });

  test('the read is throttled, so polling does not multiply the queue read load', async () => {
    const counting = countingDriver(async () => [queue('default', 3)]);
    const running = worker(counting.driver);
    await running.tick();
    await running.tick();
    await running.tick();

    expect(counting.calls()).toEqual({ stats: 1, claim: 3 });
  });

  test('a queue that cannot be measured is still worked', async () => {
    const counting = countingDriver(() => Promise.reject(new Error('connection reset')));
    await worker(counting.driver).tick();

    // Instrumentation is never allowed to stop the claim loop; the tick that could not read the
    // depth still asked for work.
    expect(counting.calls().claim).toBe(1);
    expect(depthOf('default')).toBeUndefined();
  });
});

/**
 * `jobs_total` was declared in `runtime-metrics.ts` and never emitted, so the series existed and
 * was permanently empty — depth alone cannot tell a drained queue from one nothing ever claimed.
 */
describe('the worker counts what it finished', () => {
  const outcomeOf = (name: string, outcome: string): number | undefined =>
    collectMetrics()
      .metrics.find((metric) => metric.descriptor.name === 'jobs_total')
      ?.points.find(
        (point) => point.attributes['queue'] === name && point.attributes['outcome'] === outcome,
      )?.value;

  const reporter = memoryErrorReporter();

  const runOne = async (options: { attempts: number; fail: boolean }): Promise<void> => {
    resetJobs();
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'countedJob',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `counted:${n}`,
      retry: { attempts: options.attempts, jitter: false },
      run: () => {
        if (options.fail) throw new TypeError('the dependency is down');
        return Promise.resolve();
      },
    });
    const driver = createMemoryDriver();
    await driver.enqueue({
      name: 'countedJob',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: handle.idempotencyKeyFor({ n: 1 }),
      maxAttempts: options.attempts,
    });
    await createWorker({
      driver,
      drainOnShutdown: false,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
    }).tick();
  };

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetJobs();
    resetErrorReporting();
  });

  test('a finished job lands in jobs_total, labelled by queue and outcome', async () => {
    await runOne({ attempts: 3, fail: false });

    expect(outcomeOf('default', 'ok')).toBe(1);
    // Two labels and no more: a label per job name is unbounded in the app's own vocabulary.
    const labels = collectMetrics()
      .metrics.find((metric) => metric.descriptor.name === 'jobs_total')
      ?.points.flatMap((point) => Object.keys(point.attributes));
    expect([...new Set(labels)].sort()).toEqual(['outcome', 'queue']);
  });

  test('an attempt that will be retried counts as failed and reports a warning', async () => {
    await runOne({ attempts: 3, fail: true });

    expect(outcomeOf('default', 'failed')).toBe(1);
    expect(outcomeOf('default', 'dead')).toBeUndefined();
    const event = reporter.events[0] as ErrorReport;
    expect(event.source).toBe('job');
    // Recovered from, so not a page: the queue will run it again.
    expect(event.severity).toBe('warning');
    expect(event.scope.operation).toBe('countedJob');
    expect(event.cause).toContain('the dependency is down');
  });

  test('an exhausted job counts as dead and is reported as an error, not a warning', async () => {
    await runOne({ attempts: 1, fail: true });

    expect(outcomeOf('default', 'dead')).toBe(1);
    expect((reporter.events[0] as ErrorReport).severity).toBe('error');
    expect((reporter.events[0] as ErrorReport).scope.extra?.['retry']).toBe(false);
  });
});
