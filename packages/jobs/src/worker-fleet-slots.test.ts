// The fleet slot's two failure modes, neither of which the queue can recover from on its own: an
// acquire that REJECTS (the lease store is a database, so a failover rejects it) must not keep the
// in-process slot it was taken under, and a renewal that answers `false` — another worker holds
// this slot now — must stop the run rather than let two of them share one `job.concurrency`.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, isUltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { HeldLease, LeaseStore } from './leases';
import { createMemoryLeaseStore } from './leases';
import { createLimiter } from './limits';
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

interface Gate {
  readonly passed: Promise<void>;
  open(): void;
}

/** A promise the test opens by hand — the only way to park a run inside one exact await. */
function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

afterEach(() => {
  resetJobs();
});

describe('a fleet-slot acquire that rejects', () => {
  test('gives the in-process slot back, so the worker claims again once the store recovers', async () => {
    job({
      tenant: 'none',
      name: 'cappedJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'capped',
      retry: { attempts: 1, jitter: false },
      concurrency: 3,
      run: () => Promise.resolve(),
    });

    let down = true;
    const backing = createMemoryLeaseStore();
    const leases: LeaseStore = {
      ...backing,
      acquire: (key, limit, ttlMs, holder) =>
        down
          ? Promise.reject(new Error('lease store down'))
          : backing.acquire(key, limit, ttlMs, holder),
    };
    const driver = createMemoryDriver({ leases });
    const limiter = createLimiter({});
    const worker = createWorker({
      driver,
      concurrency: 1,
      limiter,
      context,
      drainOnShutdown: false,
    });

    const enqueue = (key: string): Promise<unknown> =>
      driver.enqueue({
        name: 'cappedJob',
        queue: 'default',
        input: {},
        idempotencyKey: key,
        maxAttempts: 1,
      });

    await enqueue('capped:1');
    // The store's rejection reaches the caller — `schedule()` logs it as `jobs.worker.tick-failed`.
    await expect(worker.tick()).rejects.toThrow('lease store down');
    // And it costs this worker nothing: a burned slot is permanent, so four of them on a
    // concurrency-4 worker is the whole role dead from one transient database error.
    expect(limiter.inFlight({ queue: 'default' })).toBe(0);

    down = false;
    await enqueue('capped:2');
    expect((await worker.tick()).map((execution) => execution.job)).toEqual(['cappedJob']);
  });
});

describe('a fleet-slot renewal that answers false', () => {
  test('cancels the run instead of sharing the slot with the worker that took it', async () => {
    const started = gate();
    let reason: unknown;
    job({
      tenant: 'none',
      name: 'sharedJob',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'shared',
      retry: { attempts: 1, jitter: false },
      concurrency: 1,
      run: ({ ctx }) => {
        started.open();
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reason = ctx.signal.reason;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    const backing = createMemoryLeaseStore();
    let renewals = 0;
    const leases: LeaseStore = {
      ...backing,
      // The slot expired under this worker and another one took it: the row is somebody else's,
      // which `SQL_LEASE_RENEW`'s `holder = $3` reports as zero rows updated.
      renew: (_lease: HeldLease) => {
        renewals += 1;
        return Promise.resolve(false);
      },
    };
    const driver = createMemoryDriver({ leases });
    const worker = createWorker({
      driver,
      concurrency: 1,
      visibilityTimeoutMs: 30_000,
      heartbeatIntervalMs: 1,
      context,
      drainOnShutdown: false,
    });
    await driver.enqueue({
      name: 'sharedJob',
      queue: 'default',
      input: {},
      idempotencyKey: 'shared',
      maxAttempts: 1,
    });

    const tick = worker.tick();
    await started.passed;
    // The body ends because the run was cancelled — before the fix nothing ever aborted it and
    // this await never resolved.
    await tick;

    expect(isUltimateError(reason) && reason.code).toBe('X_JOB_SLOT_LOST');
    // Reported once and then the timer stops: renewing a slot this worker no longer holds would
    // extend somebody else's lease.
    const atLoss = renewals;
    await Bun.sleep(20);
    expect(renewals).toBe(atLoss);
  });
});
