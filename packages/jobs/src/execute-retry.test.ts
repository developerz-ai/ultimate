// The failure path reads the thrown error's retry classification, not only the attempt count.
// A `terminal` code dead-letters on the attempt it happened; an unclassified one keeps the
// attempt-count behaviour it has always had — that second half is the regression this guards.

import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { createContext, logger, registerErrorRetry, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver, NackOptions } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobExecution } from './execute';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';

/** Test-only codes: `collectDeclaredCodes` skips test files, so these never reach the manifest. */
const TERMINAL_CODE = 'X_TEST_LOGIN_REFUSED';
const RETRY_AFTER_CODE = 'X_TEST_QUOTA_EXHAUSTED';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const coded = (code: string, extra?: { retry?: 'terminal'; seconds?: number }): UltimateError =>
  new UltimateError({
    code,
    cause: 'the surveyed site refused the credential',
    fix: 'rotate the credential in the vault, then x jobs retry --json',
    ...(extra?.retry === undefined ? {} : { retry: extra.retry }),
    ...(extra?.seconds === undefined ? {} : { meta: { retryAfterSeconds: extra.seconds } }),
  });

interface Harness {
  readonly driver: JobDriver;
  execute(attempt?: number): Promise<JobExecution>;
  nacks(): readonly NackOptions[];
}

/** One claimed job on a memory queue whose handler throws whatever the test hands it. */
async function claimOne(options: {
  readonly attempts: number;
  readonly throws: () => unknown;
}): Promise<Harness> {
  resetJobs();
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'classified',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `classified:${n}`,
    retry: { attempts: options.attempts, backoff: 'fixed', delay: 1_000, jitter: false },
    run: () => Promise.reject(options.throws()),
  });
  const base = createMemoryDriver();
  const nacks: NackOptions[] = [];
  const driver: JobDriver = {
    ...base,
    async nack(jobId, nack) {
      nacks.push(nack);
      await base.nack(jobId, nack);
    },
  };
  await driver.enqueue({
    name: 'classified',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'classified:1',
    maxAttempts: options.attempts,
  });
  const claimed = (
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-test',
    })
  )[0] as ClaimedJob;
  const ctx: Ctx = createContext({ role: 'worker', buildId: 'test' });
  return {
    driver,
    // The attempt is the driver's number in production; fabricating it here is how a run at the
    // ceiling is reached without nacking four times through a delay queue.
    execute: (attempt = claimed.attempt) =>
      executeJob({ driver, claimed: { ...claimed, attempt }, handle: handle as AnyJobHandle, ctx }),
    nacks: () => nacks,
  };
}

beforeEach(() => {
  // Idempotent: re-registering the same value is allowed, so another file's `resetErrorRetry`
  // cannot leave this suite reading an empty registry.
  registerErrorRetry({ [TERMINAL_CODE]: 'terminal', [RETRY_AFTER_CODE]: 'retry-after' });
});

afterAll(() => {
  resetJobs();
});

describe('a terminal error stops on the attempt it happened', () => {
  test('dead-letters after ONE attempt instead of burning the whole policy', async () => {
    const harness = await claimOne({ attempts: 5, throws: () => coded(TERMINAL_CODE) });

    const execution = await harness.execute();

    expect(execution.outcome).toBe('dead-lettered');
    expect(execution.attempt).toBe(1);
    expect(harness.nacks()).toEqual([
      { delayMs: 0, error: expect.any(String), countsAsAttempt: true, deadLetter: true },
    ]);
  });

  test('a per-instance terminal override beats the code’s own classification', async () => {
    // `X_TIMEOUT` is classified `retryable` by core; this ONE throw says otherwise.
    const harness = await claimOne({
      attempts: 5,
      throws: () => coded('X_TIMEOUT', { retry: 'terminal' }),
    });

    expect((await harness.execute()).outcome).toBe('dead-lettered');
  });

  test('deadLetter: false still drops rather than parks it', async () => {
    resetJobs();
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'dropped',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `dropped:${n}`,
      retry: { attempts: 5, deadLetter: false, jitter: false },
      run: () => Promise.reject(coded(TERMINAL_CODE)),
    });
    const driver = createMemoryDriver();
    const nacks: NackOptions[] = [];
    const spied: JobDriver = {
      ...driver,
      async nack(jobId, nack) {
        nacks.push(nack);
        await driver.nack(jobId, nack);
      },
    };
    await spied.enqueue({
      name: 'dropped',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'dropped:1',
      maxAttempts: 5,
    });
    const claimed = (
      await spied.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-test',
      })
    )[0] as ClaimedJob;

    const execution = await executeJob({
      driver: spied,
      claimed,
      handle: handle as AnyJobHandle,
      ctx: createContext({ role: 'worker', buildId: 'test' }),
    });

    expect(execution.outcome).toBe('dead-lettered');
    expect(nacks[0]?.deadLetter).toBe(false);
  });
});

describe('every other classification keeps the attempt count in charge', () => {
  test('a retryable code retries, and still stops at the ceiling', async () => {
    const harness = await claimOne({ attempts: 3, throws: () => coded('X_TIMEOUT') });

    expect((await harness.execute(1)).outcome).toBe('retried');
    expect(harness.nacks()[0]?.delayMs).toBe(1_000);
    expect((await harness.execute(3)).outcome).toBe('dead-lettered');
  });

  // The most important test here: most codes are classified by nobody, and `retryFor` answers
  // `terminal` for all of them. Reading THAT would stop retrying every transient failure in
  // every shipped app. `X_ABORTED` is core's own worked example of a code left unclassified.
  test('an unclassified code retries exactly as it did before', async () => {
    const harness = await claimOne({ attempts: 3, throws: () => coded('X_ABORTED') });

    const execution = await harness.execute(1);

    expect(execution.outcome).toBe('retried');
    expect(harness.nacks()[0]).toMatchObject({ delayMs: 1_000, deadLetter: false });
  });

  test('a raw TypeError has no code and so keeps the attempt-count path', async () => {
    const harness = await claimOne({
      attempts: 3,
      throws: () => new TypeError('cannot read properties of undefined'),
    });

    expect((await harness.execute(1)).outcome).toBe('retried');
    expect((await harness.execute(3)).outcome).toBe('dead-lettered');
  });
});

describe('retry-after retries at the time the responder named', () => {
  test('the stated delay replaces the backoff, and counts as an attempt', async () => {
    const harness = await claimOne({
      attempts: 3,
      throws: () => coded(RETRY_AFTER_CODE, { seconds: 30 }),
    });

    const execution = await harness.execute(1);

    expect(execution.outcome).toBe('retried');
    expect(harness.nacks()[0]).toMatchObject({ delayMs: 30_000, countsAsAttempt: true });
  });

  test('a stated delay is still clamped by the policy’s maxDelay', async () => {
    resetJobs();
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'clamped',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `clamped:${n}`,
      retry: { attempts: 3, delay: 1_000, maxDelay: 60_000, jitter: false },
      run: () => Promise.reject(coded(RETRY_AFTER_CODE, { seconds: 86_400 })),
    });
    const driver = createMemoryDriver();
    const nacks: NackOptions[] = [];
    const spied: JobDriver = {
      ...driver,
      async nack(jobId, nack) {
        nacks.push(nack);
        await driver.nack(jobId, nack);
      },
    };
    await spied.enqueue({
      name: 'clamped',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'clamped:1',
      maxAttempts: 3,
    });
    const claimed = (
      await spied.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-test',
      })
    )[0] as ClaimedJob;

    await executeJob({
      driver: spied,
      claimed,
      handle: handle as AnyJobHandle,
      ctx: createContext({ role: 'worker', buildId: 'test' }),
    });

    expect(nacks[0]?.delayMs).toBe(60_000);
  });

  test('no stated time falls back to the policy backoff', async () => {
    const harness = await claimOne({ attempts: 3, throws: () => coded(RETRY_AFTER_CODE) });

    expect(harness.nacks()).toEqual([]);
    await harness.execute(1);

    expect(harness.nacks()[0]?.delayMs).toBe(1_000);
  });

  test('the attempt ceiling still wins over a stated delay', async () => {
    const harness = await claimOne({
      attempts: 3,
      throws: () => coded(RETRY_AFTER_CODE, { seconds: 30 }),
    });

    expect((await harness.execute(3)).outcome).toBe('dead-lettered');
  });
});

describe('this package classifies its own codes, and the executor acts on them', () => {
  // Not a synthetic code: a duplicate step name is a defect in the handler that replays
  // identically forever, so `errors.ts` registers `X_STEP_DUPLICATE` as terminal and the run ends
  // on the attempt it happened. Proven through the real step runner, not a hand-built error.
  test('a duplicate step name dead-letters on the first attempt', async () => {
    resetJobs();
    const handle = job<{ n: number }>({
      tenant: 'none',
      name: 'duplicate-step',
      input: passthrough<{ n: number }>(),
      idempotencyKey: ({ n }) => `duplicate-step:${n}`,
      retry: { attempts: 5, jitter: false },
      run: async ({ step }) => {
        await step.run('charge', () => 'ok');
        await step.run('charge', () => 'again');
      },
    });
    const driver = createMemoryDriver();
    await driver.enqueue({
      name: 'duplicate-step',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: 'duplicate-step:1',
      maxAttempts: 5,
    });
    const claimed = (
      await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'worker-test',
      })
    )[0] as ClaimedJob;

    const execution = await executeJob({
      driver,
      claimed,
      handle: handle as AnyJobHandle,
      ctx: createContext({ role: 'worker', buildId: 'test' }),
    });

    expect(execution.outcome).toBe('dead-lettered');
    expect(execution.attempt).toBe(1);
    expect(execution.stopReason).toBe('terminal');
  });

  test('a timeout is registered retryable, so the deadline path is unchanged', async () => {
    const harness = await claimOne({
      attempts: 3,
      throws: () => coded('X_JOB_TIMEOUT'),
    });

    expect((await harness.execute(1)).outcome).toBe('retried');
  });
});

describe('why a job stopped is readable, not inferred', () => {
  test('the log line and the execution name terminal, not exhaustion', async () => {
    const warn = spyOn(logger, 'warn');
    const harness = await claimOne({ attempts: 5, throws: () => coded(TERMINAL_CODE) });

    const execution = await harness.execute();
    const failed = warn.mock.calls.find((call) => call[0] === 'jobs.attempt.failed');
    warn.mockRestore();

    expect(failed?.[1]).toMatchObject({ retry: false, stop: 'terminal' });
    expect(execution.stopReason).toBe('terminal');
  });

  test('an exhausted policy says so instead, on the same fields', async () => {
    const warn = spyOn(logger, 'warn');
    const harness = await claimOne({ attempts: 3, throws: () => coded('X_TIMEOUT') });

    const execution = await harness.execute(3);
    const failed = warn.mock.calls.find((call) => call[0] === 'jobs.attempt.failed');
    warn.mockRestore();

    expect(failed?.[1]).toMatchObject({ retry: false, stop: 'attempts-exhausted' });
    expect(execution.stopReason).toBe('attempts-exhausted');
  });

  // The job ROW carries one failure field, `lastError`, so that is where `x jobs show` has to
  // learn why attempt 1 of 5 was the last one.
  test('the stored lastError explains a dead letter that stopped early', async () => {
    const harness = await claimOne({ attempts: 5, throws: () => coded(TERMINAL_CODE) });

    await harness.execute();

    expect(harness.nacks()[0]?.error).toContain(TERMINAL_CODE);
    expect(harness.nacks()[0]?.error).toContain('not retried');
  });

  test('a retried attempt records the failure alone, with no verdict appended', async () => {
    const harness = await claimOne({ attempts: 3, throws: () => coded('X_TIMEOUT') });

    await harness.execute(1);

    expect(harness.nacks()[0]?.error).not.toContain('not retried');
  });
});
