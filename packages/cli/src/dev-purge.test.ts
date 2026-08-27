// What the boot actually declares: one `job`, one `task` on the shipped cron, and five targets
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
import type { InboxPurgeBefore, PgInboxStore } from '@ultimat3/notify';
import { createMemoryInboxStore, resetNotifyStores, setNotifyStores } from '@ultimat3/notify';
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
  resetNotifyStores();
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

  test('sweeps every framework table in one pass, against one clock reading', async () => {
    const stores = stubStores();
    installAuthLimiter(4);
    installRetentionSweep(stores);

    const report = await runSweep();

    // NAMED, never counted: `x_notify_inbox` became the one framework table with no sweep by being
    // absent from a list nothing asserted, and a length check cannot tell which one went missing.
    expect(report.swept.map((sweep) => sweep.name)).toEqual([
      'x_idempotency',
      'x_rate_limit',
      'x_auth',
      'x_notify_deliveries',
      'x_notify_inbox',
    ]);
    // The two notify targets answer 0 here: no boot in this test installed a Postgres notify
    // store, which is exactly the state of an app that never wired one.
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

  test('a stopped boot does not disarm the boot that replaced it', async () => {
    // Two runtimes in one process — a test harness, `x shot`'s scratch server beside the one it
    // photographs. The slot is module scope by design (the job registry is process-wide too), so
    // the release has to check that it is still ITS slot: the first boot's disposer emptied the
    // second boot's targets and its hourly sweep then deleted nothing, forever, silently.
    installAuthLimiter(4);
    const releaseFirst = installRetentionSweep(stubStores());
    installRetentionSweep(stubStores());

    releaseFirst();

    expect((await runSweep()).swept.map((sweep) => sweep.name)).toEqual([
      'x_idempotency',
      'x_rate_limit',
      'x_auth',
      'x_notify_deliveries',
      'x_notify_inbox',
    ]);
  });

  // The half a config key most often loses: declared, defaulted, documented and never threaded.
  // The window has to arrive at the store as a CUTOFF measured from the job's clock, and the two
  // windows have to stay apart — a read window applied to unread rows deletes messages nobody read.
  test('each inbox window reaches the store as its own cutoff, off the job clock', async () => {
    const seen: InboxPurgeBefore[] = [];
    setNotifyStores({
      inbox: {
        ...createMemoryInboxStore(),
        purgeBefore: (before: InboxPurgeBefore) => {
          seen.push(before);
          return Promise.resolve(5);
        },
      } as PgInboxStore,
    });
    installAuthLimiter(4);
    installRetentionSweep({
      ...stubStores(),
      inboxRetention: { readMs: 60_000, unreadMs: 120_000 },
    });

    const report = await runSweep();

    expect(report.removed).toBe(14);
    const before = seen[0];
    if (before?.read === undefined || before.unread === undefined) {
      expect.unreachable('both cutoffs reached the store');
    }
    // Not asserted as absolute instants — the job reads the clock. The DIFFERENCE is the claim,
    // and it is what a swapped pair of windows would get wrong.
    expect(before.unread.getTime()).toBe(before.read.getTime() - 60_000);
  });

  // Absent is the DEFAULT, and it must reach the store as "sweep nothing" rather than as a cutoff
  // of `now - undefined`, which is `NaN` and a date every row is older than.
  test('an unset window is absent at the store, never a NaN cutoff', async () => {
    const seen: InboxPurgeBefore[] = [];
    setNotifyStores({
      inbox: {
        ...createMemoryInboxStore(),
        purgeBefore: (before: InboxPurgeBefore) => {
          seen.push(before);
          return Promise.resolve(0);
        },
      } as PgInboxStore,
    });
    installAuthLimiter(4);
    installRetentionSweep({
      ...stubStores(),
      inboxRetention: { readMs: 60_000, unreadMs: undefined },
    });

    await runSweep();

    expect(seen[0]?.unread).toBeUndefined();
    expect(seen[0]?.read).toBeInstanceOf(Date);
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
