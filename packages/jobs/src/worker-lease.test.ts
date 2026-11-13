// The worker's half of the lease contract: every claimed job gets a heartbeat, the heartbeat is
// released with the job, and renewals that stop landing are REPORTED. `.catch(() => undefined)`
// on the renewal made the one failure a queue cannot recover from on its own — a lease that
// expired under a job still running — look exactly like a healthy run. The renewals run on a
// scheduler handed in (`WorkerOptions.schedule`) and fired by hand: no interval is waited.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { collectMetrics, ctxOf, frozenClock, resetMetrics } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { manualSchedule } from './manual-schedule-fixture';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const lostCount = (queue: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'job_leases_lost_total')
    ?.points.find((point) => point.attributes['queue'] === queue)?.value;

interface Parked {
  readonly driver: JobDriver;
  readonly renewals: () => number;
  readonly running: Promise<void>;
  release(): void;
}

/**
 * One job claimed and parked mid-run, with its renewals counted. The job is held open so the
 * assertions land while the lease still matters — once the job settles there is no lease left.
 */
async function parkOne(heartbeat: () => Promise<void>): Promise<Parked> {
  let renewals = 0;
  let release = (): void => undefined;
  let started = (): void => undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  job({
    tenant: 'none',
    name: 'leasedJob',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'leased:1',
    retry: { attempts: 1, jitter: 'none' },
    run: async () => {
      started();
      await parked;
    },
  });
  const base = memoryJobDriver();
  const driver: JobDriver = {
    ...base,
    heartbeat: async () => {
      renewals += 1;
      await heartbeat();
      return true;
    },
  };
  await driver.enqueue({
    name: 'leasedJob',
    queue: 'default',
    input: {},
    idempotencyKey: 'leased:1',
    maxAttempts: 1,
  });
  return { driver, renewals: () => renewals, running, release: () => release() };
}

afterEach(() => {
  resetJobs();
  resetMetrics();
});

describe('the worker renews the lease it claimed', () => {
  test('a running job is heartbeated, and the interval stops with the job', async () => {
    const parked = await parkOne(() => Promise.resolve());
    const timers = manualSchedule();
    const worker = jobWorker({
      driver: parked.driver,
      clock: frozenClock(0),
      visibilityTimeoutMs: 5_000,
      heartbeatIntervalMs: 1,
      schedule: timers.schedule,
      context,
      drainOnShutdown: false,
    });

    const tick = worker.tick();
    await parked.running;
    // The job's lease renewal, armed at the interval asked for.
    expect(timers.ticks(1)).toHaveLength(1);
    await timers.fire(1);
    await timers.fire(1);
    expect(parked.renewals()).toBe(2);

    parked.release();
    await tick;
    // An interval per claimed job that outlived the job would be a timer leak on every run: the
    // one handed over was handed BACK, and nothing armed is left to beat.
    expect(timers.armed.size).toBe(0);
    await timers.fire();
    expect(parked.renewals()).toBe(2);
    expect(lostCount('default')).toBeUndefined();
  });

  test('renewals that stop landing past the window are reported as a lost lease', async () => {
    const clock = frozenClock(0);
    const parked = await parkOne(() => Promise.reject(new Error('connection reset')));
    const timers = manualSchedule();
    const worker = jobWorker({
      driver: parked.driver,
      clock,
      visibilityTimeoutMs: 50,
      heartbeatIntervalMs: 1,
      schedule: timers.schedule,
      context,
      drainOnShutdown: false,
    });

    const tick = worker.tick();
    await parked.running;
    // One renewal that fails inside the window is not a loss.
    await timers.fire(1);
    expect(lostCount('default')).toBeUndefined();
    // The window this worker bought at `claim()` is gone and no renewal has landed since: the
    // queue is free to hand this job to another worker while this one is still running it.
    clock.advance(51);
    await timers.fire(1);
    expect(lostCount('default')).toBe(1);

    parked.release();
    await tick;

    expect(lostCount('default')).toBe(1);
  });
});
