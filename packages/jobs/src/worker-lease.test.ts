// The worker's half of the lease contract: every claimed job gets a heartbeat, the heartbeat is
// released with the job, and renewals that stop landing are REPORTED. `.catch(() => undefined)`
// on the renewal made the one failure a queue cannot recover from on its own — a lease that
// expired under a job still running — look exactly like a healthy run.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { collectMetrics, createContext, frozenClock, resetMetrics } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

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

/** Waits for what the worker's own interval will do, bounded so a failure fails fast. */
async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1_000 && !condition(); waited += 2) await Bun.sleep(2);
}

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
    name: 'leasedJob',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'leased:1',
    retry: { attempts: 1, jitter: false },
    run: async () => {
      started();
      await parked;
    },
  });
  const base = createMemoryDriver();
  const driver: JobDriver = {
    ...base,
    heartbeat: () => {
      renewals += 1;
      return heartbeat();
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
    const worker = createWorker({
      driver: parked.driver,
      clock: frozenClock(0),
      visibilityTimeoutMs: 5_000,
      heartbeatIntervalMs: 1,
      context,
      drainOnShutdown: false,
    });

    const tick = worker.tick();
    await parked.running;
    await until(() => parked.renewals() > 0);
    expect(parked.renewals()).toBeGreaterThan(0);

    parked.release();
    await tick;
    const atEnd = parked.renewals();
    await Bun.sleep(20);

    // An interval per claimed job that outlived the job would be a timer leak on every run.
    expect(parked.renewals()).toBe(atEnd);
    expect(lostCount('default')).toBeUndefined();
  });

  test('renewals that stop landing past the window are reported as a lost lease', async () => {
    const clock = frozenClock(0);
    const parked = await parkOne(() => Promise.reject(new Error('connection reset')));
    const worker = createWorker({
      driver: parked.driver,
      clock,
      visibilityTimeoutMs: 50,
      heartbeatIntervalMs: 1,
      context,
      drainOnShutdown: false,
    });

    const tick = worker.tick();
    await parked.running;
    // The window this worker bought at `claim()` is gone and no renewal has landed since: the
    // queue is free to hand this job to another worker while this one is still running it.
    clock.advance(51);
    await until(() => lostCount('default') !== undefined);

    parked.release();
    await tick;

    expect(lostCount('default')).toBe(1);
  });
});
