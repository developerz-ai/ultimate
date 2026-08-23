// What the boot actually declares: one `job`, one `task` on the shipped cron, and three targets
// that reach the stores this boot installed. Everything here is a claim about WIRING — the
// sweeping itself is `@ultimat3/jobs`' `purge.test.ts`, and the auth half is the seam's own live
// test against real Postgres.

import { afterEach, describe, expect, test } from 'bun:test';
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  PostgresIdempotencyStore,
} from '@ultimat3/action';
import {
  configureAuthLimiters,
  defineAuth,
  MemoryAdapter,
  resetAuthLimiters,
} from '@ultimat3/auth';
import { createContext } from '@ultimat3/core';
import type { PostgresRateLimitStore, RateLimitDecision } from '@ultimat3/http';
import type { PurgeReport } from '@ultimat3/jobs';
import {
  createMemoryStepStore,
  createStepRunner,
  getJob,
  getTask,
  resetJobs,
  resetTasks,
} from '@ultimat3/jobs';
import type { RetentionStores } from './dev-purge';
import { installRetentionSweep, PURGE_JOB_NAME, PURGE_TASK_NAME } from './dev-purge';

/** Counts sweeps and records the clock each was measured against; it stores nothing. */
function stubStores(): RetentionStores & { readonly at: number[] } {
  const at: number[] = [];
  const idempotency: PostgresIdempotencyStore = {
    scope: 'shared',
    windowMs: 86_400_000,
    reserve: (): Promise<IdempotencyReservation> => Promise.reject(new TypeError('not used')),
    settle: (): Promise<void> => Promise.resolve(),
    release: (): Promise<void> => Promise.resolve(),
    get: (): Promise<IdempotencyRecord | undefined> => Promise.resolve(undefined),
    purgeExpired: (): Promise<number> => Promise.resolve(2),
  };
  const rateLimit: PostgresRateLimitStore = {
    scope: 'shared',
    take: (): Promise<RateLimitDecision> => Promise.reject(new TypeError('not used')),
    reset: (): Promise<void> => Promise.resolve(),
    purgeExpired: (nowMs: number): Promise<number> => {
      at.push(nowMs);
      return Promise.resolve(3);
    },
  };
  return { idempotency, rateLimit, at };
}

/**
 * A limiter over nothing that answers a fixed row count, plus the `defineAuth` that BUILDS one:
 * `purgeAuthLimits()` sweeps what the factory produced, and until an app calls `defineAuth` there
 * is nothing to sweep — which is the honest answer for a deployment with no auth at all.
 */
const installAuthLimiter = (removed: number): void => {
  configureAuthLimiters((policy) => ({
    policy: { ...policy, scope: 'shared' },
    assertAllowed: async (): Promise<void> => undefined,
    recordFailure: async (): Promise<void> => undefined,
    recordSuccess: async (): Promise<void> => undefined,
    lockedUntil: async (): Promise<Date | null> => null,
    reset: async (): Promise<void> => undefined,
    purgeExpired: async (): Promise<number> => removed,
  }));
  defineAuth({ adapter: new MemoryAdapter() });
};

async function runSweep(): Promise<PurgeReport> {
  const handle = getJob(PURGE_JOB_NAME);
  if (handle === undefined) expect.unreachable(`${PURGE_JOB_NAME} was never declared`);
  const runner = createStepRunner({
    runId: crypto.randomUUID(),
    jobName: handle.name,
    store: createMemoryStepStore(),
  });
  const result = await handle.run({
    input: {},
    step: runner.step,
    ctx: createContext({ role: 'worker' }),
    attempt: 1,
    jobId: 'job-1',
    runId: 'run-1',
  });
  return result as PurgeReport;
}

afterEach(() => {
  resetAuthLimiters();
  resetJobs();
  resetTasks();
});

describe('installRetentionSweep', () => {
  test('declares one job and one task on the shipped hourly cron', () => {
    installRetentionSweep(stubStores());

    expect(getJob(PURGE_JOB_NAME)?.kind).toBe('job');
    const scheduled = getTask(PURGE_TASK_NAME);
    expect(scheduled?.cron).toBe('23 * * * *');
    // Required by `task()` and never inferred — an unzoned cron drifts an hour at every DST switch.
    expect(scheduled?.tz).toBe('UTC');
    // The task enqueues the sweep and nothing else: a task never does work.
    expect(scheduled?.describe().jobs).toEqual([PURGE_JOB_NAME]);
  });

  test('sweeps all three framework tables in one pass, against one clock reading', async () => {
    const stores = stubStores();
    installAuthLimiter(4);
    installRetentionSweep(stores);

    const report = await runSweep();

    expect(report.swept.map((sweep) => sweep.name)).toEqual([
      'x_idempotency',
      'x_rate_limit',
      'x_auth',
    ]);
    expect(report.removed).toBe(9);
    // The rate-limit store is the one that takes a clock, and it must be the JOB's: `last_ms` is
    // written by whichever process took the token, so a purge measured against `now()` in Postgres
    // computes a refill from the offset between two clocks.
    expect(stores.at).toHaveLength(1);
    expect(stores.at[0]).toBeGreaterThan(1_700_000_000_000);
  });

  test('the release leaves a sweep that reaches through nothing', async () => {
    installAuthLimiter(4);
    const release = installRetentionSweep(stubStores());

    release();

    // A boot that has stopped closed its pool; a sweep still on the schedule must not reach
    // through it. The job stays registered — the registry is process-wide and the next boot
    // fills the targets back in.
    expect(await runSweep()).toEqual({ swept: [], removed: 0 });
  });

  test('a second boot in the same process re-declares what a reset took out', () => {
    installRetentionSweep(stubStores());
    resetJobs();
    resetTasks();

    installRetentionSweep(stubStores());

    // A memoised handle that is no longer seated is one the worker's `getJob` can never find.
    expect(getJob(PURGE_JOB_NAME)).toBeDefined();
    expect(getTask(PURGE_TASK_NAME)).toBeDefined();
  });
});
