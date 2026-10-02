// `concurrency: { key, limit, whenBusy }` on the memory driver: the shared two-worker scenarios
// under an INJECTED clock, plus everything that needs no second driver to prove — the declaration
// refusals, the enqueue refusal, `finalAttempt`, the boot refusals and the lease key's shape.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, isUltimateError, logger } from '@ultimat3/core';
import type { KeyedConcurrency } from './concurrency';
import { MAX_CONCURRENCY_KEY_LENGTH } from './concurrency';
import type { JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { inspectJob, inspectManifest } from './inspect';
import { job, resetJobs } from './job';
import type { AccountInput, KeyedHarness } from './keyed-concurrency-fixture';
import {
  accountJob,
  enqueueRun,
  keyedConcurrencyScenarios,
  passthrough,
  rowOf,
  TTL_MS,
  workerOn,
} from './keyed-concurrency-fixture';
import { createMemoryLeaseStore, jobLeaseKey } from './leases';
import { isFinalAttempt } from './retry';
import { createScheduler } from './scheduler';
import { resetTasks, task } from './task';
import { createWorker } from './worker';

const clock = frozenClock('2026-10-01T00:00:00.000Z');

const harness: KeyedHarness = {
  clock,
  driver: () => Promise.resolve(createMemoryDriver({ clock })),
  elapse: (_driver, ms) => {
    clock.advance(ms);
    return Promise.resolve();
  },
};

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

/** The refusal a call raised, as its code and its two instruction lines — or nothing. */
const refusalOf = (call: () => unknown): { code?: string; cause?: string; fix?: string } => {
  try {
    call();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return { cause: String(error) };
  }
  return {};
};

const declare = (concurrency: unknown, name: string) => () =>
  job<AccountInput>({
    name,
    tenant: 'none',
    input: passthrough<AccountInput>(),
    idempotencyKey: ({ account }) => account,
    retry: { attempts: 1 },
    concurrency: concurrency as KeyedConcurrency<AccountInput>,
    run: () => Promise.resolve(),
  });

describe('keyed concurrency', () => {
  keyedConcurrencyScenarios('memory', harness);
});

describe('a keyed concurrency declaration', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses limit %p where the job is declared',
    (limit) => {
      const refusal = refusalOf(declare({ key: () => 'k', limit }, `bad-limit-${String(limit)}`));
      expect(refusal.code).toBe('X_JOB_DECLARATION_INVALID');
      expect(refusal.cause).toContain('concurrency.limit');
      expect(refusal.fix).toContain('set a whole concurrency.limit of 1 or more');
    },
  );

  test('refuses a key that is not a function, and a whenBusy that is not one of the two', () => {
    const noKey = refusalOf(declare({ key: 'account', limit: 1 }, 'bad-key'));
    expect(noKey.code).toBe('X_JOB_DECLARATION_INVALID');
    expect(noKey.cause).toContain('concurrency.key "account"');

    const busy = refusalOf(declare({ key: () => 'k', limit: 1, whenBusy: 'drop' }, 'bad-busy'));
    expect(busy.code).toBe('X_JOB_DECLARATION_INVALID');
    expect(busy.cause).toContain('concurrency.whenBusy "drop"');
    expect(busy.fix).toContain("'wait'");

    expect(refusalOf(declare('one', 'bad-shape')).code).toBe('X_JOB_DECLARATION_INVALID');
  });

  test('a refused declaration seats no job, so the corrected one can take the name', () => {
    expect(refusalOf(declare({ key: () => 'k', limit: 0 }, 'reseat')).code).toBeDefined();
    expect(refusalOf(declare({ key: () => 'k', limit: 1 }, 'reseat'))).toEqual({});
  });

  test('resolves on the handle: the limit, whenBusy defaulting to wait, and the key by method', () => {
    const waits = accountJob({ concurrency: { key: ({ account }) => account, limit: 2 } }).handle;
    expect(waits.concurrency).toBe(2);
    expect(waits.whenBusy).toBe('wait');
    expect(waits.concurrencyKeyFor({ account: 'acct-9' })).toBe('acct-9');
    expect(waits.describe().concurrency).toEqual({ limit: 2, keyed: true, whenBusy: 'wait' });

    const plain = accountJob({ concurrency: 3 }).handle;
    expect(plain.whenBusy).toBeUndefined();
    expect(plain.concurrencyKeyFor({ account: 'acct-9' })).toBeUndefined();
    expect(plain.describe().concurrency).toEqual({ limit: 3, keyed: false, whenBusy: null });

    expect(accountJob({}).handle.describe().concurrency).toBeNull();
  });
});

describe('a concurrency key at enqueue', () => {
  test.each([
    ['', 'empty string'],
    ['k'.repeat(MAX_CONCURRENCY_KEY_LENGTH + 1), 'longer than a lease row can be keyed by'],
  ])('refuses %p before anything is queued', async (key, why) => {
    const driver = createMemoryDriver({ clock });
    setJobDriver(driver);
    const probe = accountJob({ concurrency: { key: () => key, limit: 1 } });

    const refusal = await probe.handle.enqueue({ account: 'acct-1' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isUltimateError(refusal) && refusal.code).toBe('X_JOB_DECLARATION_INVALID');
    expect(isUltimateError(refusal) && refusal.cause).toContain(why);
    // The key is app data: it is named by neither line.
    if (key !== '') expect(isUltimateError(refusal) && refusal.cause).not.toContain(key);
    expect(await driver.introspect?.list()).toEqual([]);
  });

  test('a good key enqueues, and a plain cap asks no key at all', async () => {
    const driver = createMemoryDriver({ clock });
    setJobDriver(driver);
    await accountJob({ concurrency: { key: ({ account }) => account, limit: 1 } }).handle.enqueue({
      account: 'acct-1',
    });
    await accountJob({ concurrency: 1 }).handle.enqueue({ account: 'acct-1' });
    expect(await driver.introspect?.list()).toHaveLength(2);
  });
});

describe('a concurrency key at a scheduled enqueue', () => {
  test('the scheduler refuses an empty key too — it is the one enqueue that skips the facade', async () => {
    const driver = createMemoryDriver({ clock });
    const probe = accountJob({ concurrency: { key: () => '', limit: 1 } });
    task({
      name: 'keyed-nightly',
      cron: '0 * * * *',
      tz: 'UTC',
      enqueue: () => [[probe.handle, { account: 'acct-1' }]],
    });
    const failures = spyOn(logger, 'error');
    const hourly = (_cron: string, options: { from: Date }): Date =>
      new Date(Math.floor(options.from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
    const scheduler = createScheduler({ driver, clock, cron: hourly });

    await scheduler.tick();
    clock.advance(2 * 3_600_000);
    const dispatched = await scheduler.tick();
    const refused = failures.mock.calls.filter((call) => call[0] === 'jobs.task.round_failed');
    failures.mockRestore();

    expect(dispatched).toEqual([]);
    expect(await driver.introspect?.list()).toEqual([]);
    expect(refused.map((call) => (call[1] as { code?: string }).code)).toEqual([
      'X_JOB_DECLARATION_INVALID',
    ]);
  });
});

describe('a key the worker cannot derive at claim', () => {
  test('fails that attempt without running the body, and never the claim round', async () => {
    const driver = createMemoryDriver({ clock });
    let broken = true;
    const probe = accountJob({
      retry: { attempts: 2, jitter: false, delay: 1_000 },
      concurrency: {
        key: ({ account }) => {
          if (broken && account === 'poison') throw new TypeError('no account on this row');
          return account;
        },
        limit: 1,
      },
    });
    const poison = await enqueueRun(driver, probe, 'poison');
    await enqueueRun(driver, probe, 'acct-1');
    const worker = createWorker({
      driver,
      clock,
      concurrency: 2,
      pollIntervalMs: 0,
      context: () => ({}) as never,
      drainOnShutdown: false,
    });

    // The round RESOLVES — a throw here would hand both runs back uncounted, every pass, forever.
    const executions = await worker.tick();

    expect(executions.map((execution) => execution.outcome).sort()).toEqual([
      'completed',
      'retried',
    ]);
    expect(probe.calls.map((call) => call.account)).toEqual(['acct-1']);
    const row = await rowOf(driver, poison);
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain('no account on this row');

    // And it is an ordinary failed attempt: fixed, the retry runs.
    broken = false;
    clock.advance(5_000);
    expect((await worker.tick()).map((execution) => execution.outcome)).toEqual(['completed']);
  });
});

describe('finalAttempt', () => {
  test('is true exactly once — on the attempt the runner dead-letters', async () => {
    const driver = createMemoryDriver({ clock });
    const probe = accountJob({
      retry: { attempts: 3, jitter: false, delay: 1_000, backoff: 'fixed' },
      body: () => Promise.reject(new TypeError('always fails')),
    });
    await enqueueRun(driver, probe, 'acct-1');
    const worker = workerOn(harness, driver, 'worker-a');

    const outcomes: string[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      outcomes.push(...(await worker.tick()).map((execution) => execution.outcome));
      clock.advance(60_000);
    }

    expect(outcomes).toEqual(['retried', 'retried', 'dead-lettered']);
    expect(probe.calls.map((call) => call.finalAttempt)).toEqual([false, false, true]);
  });

  test('the exported comparison is the runner`s: a hand-built call states what the worker would', () => {
    const policy = { attempts: 2 };
    expect([1, 2, 3].map((attempt) => isFinalAttempt(policy, attempt))).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe('a driver that cannot hold a keyed cap', () => {
  const startOn = (driver: JobDriver) => () =>
    createWorker({ driver, context: () => ({}) as never, drainOnShutdown: false }).start();

  test('with no lease store, the worker refuses to start', () => {
    const { leases: _leases, ...leaseless } = createMemoryDriver({ clock });
    const probe = accountJob({ concurrency: { key: ({ account }) => account, limit: 1 } });

    const refusal = refusalOf(startOn({ ...leaseless, name: 'leaseless' }));

    expect(refusal.code).toBe('X_JOB_CONCURRENCY_UNENFORCEABLE');
    expect(refusal.cause).toContain(probe.handle.name);
    expect(refusal.cause).toContain('has no lease store');
  });
});

describe('the lease a keyed cap is held under', () => {
  test('cannot collide with a plain cap, or with another job whose name contains the separator', () => {
    expect(jobLeaseKey('sync')).toBe('job:sync');
    expect(jobLeaseKey('sync', 'acct-1')).toBe('job-key:sync:acct-1');
    // Job `a` keyed `b:c` and job `a:b` keyed `c` are two jobs, so they are two leases.
    expect(jobLeaseKey('a', 'b:c')).not.toBe(jobLeaseKey('a:b', 'c'));
    // And neither is the plain cap of a job that happens to be named like one.
    expect(jobLeaseKey('a', 'b')).not.toBe(jobLeaseKey('a:b'));
  });

  test('is forgotten by the memory store once nothing holds it', async () => {
    const leases = createMemoryLeaseStore({ clock });
    const released = await leases.acquire('job-key:sync:acct-1', 1, TTL_MS, 'w:1');
    await leases.acquire('job-key:sync:acct-2', 1, TTL_MS, 'w:2');
    expect(await leases.held('job-key:sync:never-held')).toBe(0);
    expect(leases.tracked()).toBe(2);

    if (released === undefined) return expect.unreachable('the first acquire was refused');
    await leases.release(released);
    expect(leases.tracked()).toBe(1);
    // The other one is left to expire: a key per account must not be a row per account forever.
    clock.advance(TTL_MS + 1);
    expect(leases.tracked()).toBe(0);
  });
});

describe('a run reports the key it counts under', () => {
  test('inspectJob names the key of a keyed run, and null for every run that has none', async () => {
    const driver = createMemoryDriver({ clock });
    let broken = false;
    const keyedProbe = accountJob({
      concurrency: {
        key: ({ account }) => {
          if (broken) throw new TypeError('unreadable row');
          return account;
        },
        limit: 1,
        whenBusy: 'fail',
      },
    });
    const plainProbe = accountJob({ concurrency: 1 });
    const keyedId = await enqueueRun(driver, keyedProbe, 'acct-7');
    const plainId = await enqueueRun(driver, plainProbe, 'acct-7');

    expect((await inspectJob(driver, keyedId))?.concurrencyKey).toBe('acct-7');
    expect((await inspectJob(driver, plainId))?.concurrencyKey).toBeNull();
    // A trace is read to debug a stuck queue: a key it cannot derive degrades, never refuses.
    broken = true;
    expect((await inspectJob(driver, keyedId))?.concurrencyKey).toBeNull();

    const rows = inspectManifest().jobs;
    expect(rows.find((row) => row.name === keyedProbe.handle.name)).toMatchObject({
      concurrency: 1,
      whenBusy: 'fail',
    });
    expect(rows.find((row) => row.name === plainProbe.handle.name)).toMatchObject({
      concurrency: 1,
      whenBusy: null,
    });
  });
});
