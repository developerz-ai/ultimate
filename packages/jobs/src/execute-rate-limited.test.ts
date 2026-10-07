// A rate-limit refusal is not a failed attempt. `X_RATE_LIMITED` from an action the job runs (an
// `llm()` call over its declared `rateLimit:`) means "not yet", so the run is rescheduled for its
// `Retry-After` with the attempt UNCOUNTED — a suspension's shape. Counted, a backlog of rate-
// limited jobs burned its attempts against a bucket that was only ever going to refill, and was
// dead-lettered for having waited.

import { afterAll, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver, NackOptions } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';
import { rateLimitDeferralMs } from './retry-classification';

const passthrough = <T>(): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value) => ({ value: value as T }),
  },
});

/** What `@ultimat3/http`'s `rateLimited()` builds: the code, and the seconds in `meta`. */
const refused = (seconds: number): UltimateError =>
  new UltimateError({
    code: 'X_RATE_LIMITED',
    cause: `the rate limit for this caller is exhausted; it refills in ${seconds}s`,
    fix: 'retry after the Retry-After header',
    meta: { retryAfterSeconds: seconds },
  });

async function runOnce(attempts: number, attempt: number, thrown: unknown) {
  resetJobs();
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'summarize',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `summarize:${n}`,
    retry: { attempts, backoff: 'fixed', delay: 1_000, jitter: false, maxDelay: 60_000 },
    run: () => Promise.reject(thrown),
  });
  const base = memoryJobDriver();
  const nacks: NackOptions[] = [];
  const driver: JobDriver = {
    ...base,
    async nack(jobId, nack) {
      nacks.push(nack);
      return base.nack(jobId, nack);
    },
  };
  await driver.enqueue({
    name: 'summarize',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'summarize:1',
    maxAttempts: attempts,
  });
  const claimed = (
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    })
  )[0] as ClaimedJob;
  const ctx: Ctx = ctxOf({ role: 'worker', buildId: 'test' });
  const execution = await executeJob({
    driver,
    claimed: { ...claimed, attempt },
    handle: handle as AnyJobHandle,
    ctx,
  });
  return { execution, nacks };
}

afterAll(() => resetJobs());

describe('a rate-limit refusal reschedules without spending an attempt', () => {
  test('on the LAST attempt it is rescheduled, never dead-lettered', async () => {
    const { execution, nacks } = await runOnce(3, 3, refused(30));
    expect(execution.outcome).toBe('retried');
    expect(nacks).toEqual([expect.objectContaining({ countsAsAttempt: false })]);
    expect(nacks[0]?.deadLetter).not.toBe(true);
    // Never before the bucket refills, and spread over half the wait again after it.
    expect(nacks[0]?.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(nacks[0]?.delayMs).toBeLessThanOrEqual(45_000);
  });

  test('a stated wait longer than maxDelay is the floor: a 3600 s refusal defers ≥ 3600 s', async () => {
    const { nacks } = await runOnce(3, 1, refused(3_600));
    // Before the refill the run is refused again; maxDelay bounds only the spread on top.
    expect(nacks[0]?.delayMs).toBeGreaterThanOrEqual(3_600_000);
    expect(nacks[0]?.delayMs).toBeLessThan(3_600_000 + 60_000);
  });

  test('any other failure still counts — the control', async () => {
    const other = new UltimateError({ code: 'X_TEST_BROKEN', cause: 'broken', fix: 'fix it' });
    const { nacks } = await runOnce(3, 1, other);
    expect(nacks[0]?.countsAsAttempt).toBe(true);
  });
});

describe('refused jobs do not wake together', () => {
  const policy = {
    attempts: 3,
    backoff: 'fixed',
    delay: 1_000,
    jitter: false,
    maxDelay: 60_000,
  } as const;

  test('the deferral is spread by the Random seam over half the stated wait', () => {
    expect(rateLimitDeferralMs(policy, 1, refused(30), () => 0)).toBe(30_000);
    expect(rateLimitDeferralMs(policy, 1, refused(30), () => 0.999_999)).toBe(44_999);
    expect(rateLimitDeferralMs(policy, 1, refused(30), () => 0.5)).toBe(37_500);
  });

  test('the spread is bounded by maxDelay; the stated wait never is', () => {
    expect(rateLimitDeferralMs(policy, 1, refused(3_600), () => 0)).toBe(3_600_000);
    expect(rateLimitDeferralMs(policy, 1, refused(3_600), () => 0.999_999)).toBe(3_659_999);
  });

  test('a hundred refusals of one bucket wake at many moments, not one', () => {
    const wakes = new Set<number>();
    for (let i = 0; i < 100; i += 1) wakes.add(rateLimitDeferralMs(policy, 1, refused(30)) ?? 0);
    expect(wakes.size).toBeGreaterThan(50);
  });
});
