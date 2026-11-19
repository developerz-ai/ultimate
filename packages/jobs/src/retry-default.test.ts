// The retry a job that declares none runs under: `DEFAULT_RETRY` until the boot installs the
// app's own (`jobs.maxAttempts`, `jobs.backoff`), and a job's own `retry` over either.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import {
  installDefaultRetry,
  installJobDriver,
  resetDefaultRetry,
  resetJobDriver,
} from './adapter';
import { memoryJobDriver } from './driver-memory';
import { factoryJob, job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { purge } from './purge';
import { DEFAULT_RETRY, retrySchedule } from './retry';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const declared = (retry: Parameters<typeof job>[0]['retry']) =>
  job({
    tenant: 'none',
    name: 'declared',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'k',
    retry,
    run: () => Promise.resolve(),
  });

beforeEach(() => {
  resetJobs();
  resetJobDriver();
  resetJobsFacade();
});

afterEach(() => {
  resetDefaultRetry();
  resetJobDriver();
  resetJobsFacade();
});

describe('the retry of a job that declares none', () => {
  test('with nothing installed it is DEFAULT_RETRY: 3 attempts, exponential', () => {
    const sweep = purge({ name: 'sweep', targets: () => [] });
    expect(sweep.retry).toEqual(DEFAULT_RETRY);
    expect(retrySchedule(sweep.retry)).toEqual([1_000, 2_000]);
  });

  test("the installed default reaches it — installed AFTER the handle was built, as a boot's is", () => {
    const sweep = purge({ name: 'sweep', targets: () => [] });
    installDefaultRetry({ attempts: 5, backoff: 'fixed' });
    expect(sweep.retry).toEqual({ ...DEFAULT_RETRY, attempts: 5, backoff: 'fixed' });
    expect(retrySchedule(sweep.retry)).toEqual([1_000, 1_000, 1_000, 1_000]);
    resetDefaultRetry();
    expect(sweep.retry).toEqual(DEFAULT_RETRY);
  });

  test('the row it is enqueued as carries the installed attempts', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const sweep = purge({ name: 'sweep', targets: () => [] });
    installDefaultRetry({ attempts: 5, backoff: 'exponential' });
    await sweep.enqueue({});
    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.maxAttempts).toBe(5);
  });

  test("a job's own retry wins: its attempts always, its backoff when it names one", () => {
    installDefaultRetry({ attempts: 5, backoff: 'fixed' });
    expect(declared({ attempts: 2 }).retry).toEqual({
      ...DEFAULT_RETRY,
      attempts: 2,
      backoff: 'fixed',
    });
    resetJobs();
    expect(declared({ attempts: 2, backoff: 'linear' }).retry.backoff).toBe('linear');
  });

  test('an installed count that is not a whole number of at least 1 is refused', () => {
    expect(() => installDefaultRetry({ attempts: 0, backoff: 'fixed' })).toThrow(/X_INVARIANT/);
    expect(() => installDefaultRetry({ attempts: 2.5, backoff: 'fixed' })).toThrow(/X_INVARIANT/);
    expect(purge({ name: 'sweep', targets: () => [] }).retry).toEqual(DEFAULT_RETRY);
  });

  test('a factory\'s `retry: undefined` is "declares none": the installed default, read late', () => {
    const none = factoryJob({
      tenant: 'none',
      name: 'none',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'k',
      retry: undefined,
      run: () => Promise.resolve(),
    });
    expect(none.retry).toEqual(DEFAULT_RETRY);
    installDefaultRetry({ attempts: 5, backoff: 'fixed' });
    expect(none.retry).toEqual({ ...DEFAULT_RETRY, attempts: 5, backoff: 'fixed' });
  });

  test("a policy spelled out as DEFAULT_RETRY's values is DECLARED: its own 3 attempts", () => {
    installDefaultRetry({ attempts: 5, backoff: 'fixed' });
    expect(declared({ ...DEFAULT_RETRY }).retry.attempts).toBe(3);
  });

  test('job() still refuses an omitted or undefined retry: an app states its own', () => {
    const loose = {
      tenant: 'none',
      name: 'omitted',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'k',
      run: () => Promise.resolve(),
    } as unknown as Parameters<typeof job>[0];
    expect(() => job(loose)).toThrow(/X_JOB_DECLARATION_INVALID/);
    expect(() => job({ ...loose, retry: undefined } as unknown as typeof loose)).toThrow(
      /X_JOB_DECLARATION_INVALID/,
    );
  });
});
