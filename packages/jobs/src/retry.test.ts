import { describe, expect, test } from 'bun:test';
import type { RetryPolicy } from './retry';
import { backoffDelayMs, nextRetry, retrySchedule } from './retry';

const exponential: RetryPolicy = {
  attempts: 5,
  backoff: 'exponential',
  delay: 1_000,
  maxDelay: 3_600_000,
  jitter: 'none',
};

describe('backoff schedules', () => {
  test('exponential doubles from the base delay', () => {
    expect(retrySchedule(exponential)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  test('exponential is clamped by maxDelay', () => {
    expect(retrySchedule({ ...exponential, attempts: 8, maxDelay: 10_000 })).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });

  test('linear and fixed', () => {
    expect(retrySchedule({ ...exponential, backoff: 'linear' })).toEqual([
      1_000, 2_000, 3_000, 4_000,
    ]);
    expect(retrySchedule({ ...exponential, backoff: 'fixed' })).toEqual([
      1_000, 1_000, 1_000, 1_000,
    ]);
  });

  test('duration strings are accepted for delay and maxDelay', () => {
    expect(retrySchedule({ attempts: 3, backoff: 'fixed', delay: '30s', jitter: 'none' })).toEqual([
      30_000, 30_000,
    ]);
  });

  test('equal jitter stays within [half, full] of the deterministic delay', () => {
    const jittered: RetryPolicy = { ...exponential, jitter: 'equal' };
    expect(backoffDelayMs(jittered, 3, () => 0)).toBe(2_000);
    expect(backoffDelayMs(jittered, 3, () => 1)).toBe(4_000);
    expect(backoffDelayMs(jittered, 3, () => 0.5)).toBe(3_000);
  });

  // `jitter` was the one option with no `DEFAULT_RETRY` fallback while its own doc says "Equal
  // jitter … by default", so an omitted `jitter` retried in lockstep — the thundering herd the
  // default exists to break. Masked for jobs declared through `job()`, which merges the defaults;
  // this is the exported function, and `retrySchedule` reads it directly.
  test('an omitted jitter takes the documented default, not "off"', () => {
    const declared: RetryPolicy = { attempts: 3, backoff: 'exponential', delay: 1_000 };

    expect(backoffDelayMs(declared, 3, () => 0)).toBe(2_000);
    expect(backoffDelayMs(declared, 3, () => 1)).toBe(4_000);
    // An explicit `'none'` still turns it off — the default is a default, not a policy.
    expect(backoffDelayMs({ ...declared, jitter: 'none' }, 3, () => 0)).toBe(4_000);
  });

  // 31.0.0: `jitter` is core's `JitterMode`, not a flag mapped onto two of its three modes, so a
  // job that wants the herd fully decorrelated says `'full'` like every other retry in the framework.
  test("jitter is core's JitterMode: 'full' reaches zero, 'equal' keeps a floor", () => {
    expect(backoffDelayMs({ ...exponential, jitter: 'full' }, 3, () => 0)).toBe(0);
    expect(backoffDelayMs({ ...exponential, jitter: 'full' }, 3, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs({ ...exponential, jitter: 'equal' }, 3, () => 0)).toBe(2_000);
  });
});

describe('nextRetry', () => {
  test('retries until attempts is reached, then dead-letters', () => {
    expect(nextRetry(exponential, 1)).toEqual({
      retry: true,
      delayMs: 1_000,
      deadLetter: false,
      nextAttempt: 2,
    });
    expect(nextRetry(exponential, 4)).toEqual({
      retry: true,
      delayMs: 8_000,
      deadLetter: false,
      nextAttempt: 5,
    });
    expect(nextRetry(exponential, 5)).toEqual({
      retry: false,
      delayMs: 0,
      deadLetter: true,
      nextAttempt: 5,
    });
  });

  test('deadLetter: false drops an exhausted job instead of parking it', () => {
    expect(nextRetry({ ...exponential, deadLetter: false }, 5).deadLetter).toBe(false);
  });

  test('attempts: 1 means no retry at all', () => {
    expect(retrySchedule({ attempts: 1, backoff: 'exponential' })).toEqual([]);
    expect(nextRetry({ attempts: 1, backoff: 'exponential' }, 1).retry).toBe(false);
  });
});
