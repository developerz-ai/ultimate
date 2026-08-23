// Pins the one claim `backoffDelayMs` rests on after it stopped doing its own arithmetic: it IS
// core's `backoffDelay`, under this package's option names. A grid rather than three samples —
// a delegation is only equivalent if it is equivalent everywhere a caller can reach.

import { describe, expect, test } from 'bun:test';
import { backoffDelay } from '@ultimat3/core';
import type { BackoffStrategy, RetryPolicy } from './retry';
import { backoffDelayMs, DEFAULT_RETRY, retrySchedule } from './retry';

const CURVES: readonly BackoffStrategy[] = ['exponential', 'linear', 'fixed'];
const BASES: readonly number[] = [1, 7, 500, 1_000, 1_234, 30_000];
const CAPS: readonly number[] = [1, 999, 30_000, 3_600_000];
// Both ends included: `0` and `1` are where `equal` collapses onto half and onto full, which is
// where a mode swapped for `full` would still agree at one of them and disagree at the other.
const ROLLS: readonly number[] = [0, 0.1, 0.25, 1 / 3, 0.5, 0.7331, 0.999, 1];

describe('backoffDelayMs is core backoffDelay', () => {
  test('every curve, base, cap, attempt and roll agrees to the millisecond', () => {
    let compared = 0;
    for (const curve of CURVES) {
      for (const base of BASES) {
        for (const max of CAPS) {
          for (let attempt = 1; attempt <= 12; attempt += 1) {
            for (const roll of ROLLS) {
              for (const jitter of [true, false]) {
                const policy: RetryPolicy = {
                  attempts: 20,
                  backoff: curve,
                  delay: base,
                  maxDelay: max,
                  jitter,
                };
                expect(backoffDelayMs(policy, attempt, () => roll)).toBe(
                  backoffDelay({
                    attempt,
                    base,
                    max,
                    factor: 2,
                    curve,
                    jitter: jitter ? 'equal' : 'none',
                    random: () => roll,
                  }),
                );
                compared += 1;
              }
            }
          }
        }
      }
    }
    // The loops ran. A grid that silently degenerates to zero comparisons is a green test that
    // proves nothing, which is the failure mode a grid invites.
    expect(compared).toBe(13_824);
  });

  test('the attempt is 1-BASED on both sides, unshifted', () => {
    const policy: RetryPolicy = {
      attempts: 9,
      backoff: 'exponential',
      delay: 1_000,
      jitter: false,
    };

    // The delay after attempt 1 failed is the BASE, never base*factor.
    expect(backoffDelayMs(policy, 1)).toBe(1_000);
    expect(backoffDelayMs(policy, 2)).toBe(2_000);
    expect(backoffDelayMs(policy, 3)).toBe(4_000);
  });

  test('the jitter mapping is EQUAL, never full', () => {
    const policy: RetryPolicy = { attempts: 9, backoff: 'fixed', delay: 4_000, jitter: true };

    // A `full` mapping would answer 0 on a zero roll; equal keeps the latency floor at half.
    expect(backoffDelayMs(policy, 1, () => 0)).toBe(2_000);
    expect(backoffDelayMs(policy, 1, () => 1)).toBe(4_000);
  });

  test('the cap lands BEFORE the jitter, as it always did here', () => {
    const policy: RetryPolicy = {
      attempts: 20,
      backoff: 'exponential',
      delay: 1_000,
      maxDelay: 10_000,
      jitter: true,
    };

    // Raw would be 128_000 at attempt 8; capped first, so equal jitter spans [5_000, 10_000].
    expect(backoffDelayMs(policy, 8, () => 0)).toBe(5_000);
    expect(backoffDelayMs(policy, 8, () => 1)).toBe(10_000);
  });

  test("this package's defaults survive the delegation", () => {
    // No `backoff`, no `delay`, no `maxDelay`, no `jitter` — every one comes from DEFAULT_RETRY.
    const declared: RetryPolicy = { attempts: 4 };

    expect(DEFAULT_RETRY.backoff).toBe('exponential');
    expect(backoffDelayMs(declared, 3, () => 1)).toBe(4_000);
    expect(backoffDelayMs(declared, 3, () => 0)).toBe(2_000);
    expect(retrySchedule({ ...declared, jitter: false })).toEqual([1_000, 2_000, 4_000]);
  });

  test('a duration STRING is still this package’s job, not core’s', () => {
    // core takes numbers; `toMs` stays on this side of the seam, so `'30s'` keeps working.
    expect(backoffDelayMs({ attempts: 3, backoff: 'fixed', delay: '30s', jitter: false }, 1)).toBe(
      30_000,
    );
    expect(
      backoffDelayMs(
        { attempts: 3, backoff: 'exponential', delay: '1m', maxDelay: '90s', jitter: false },
        3,
      ),
    ).toBe(90_000);
  });
});

// The three inputs on which core is deliberately NOT byte-identical to the arithmetic this file
// replaced. Every one of them is an input no valid policy or job row produces, and on every one
// core answers the safer number. Pinned so the change is visible rather than discovered.
describe('invalid inputs answer core’s number, not the old one', () => {
  const policy: RetryPolicy = {
    attempts: 5,
    backoff: 'exponential',
    delay: 1_000,
    maxDelay: 3_600_000,
    jitter: false,
  };

  test('a NaN attempt is 0, where it used to be NaN', () => {
    // `setTimeout(NaN)` fires IMMEDIATELY: the old NaN was a retry loop with no wait at all.
    expect(backoffDelayMs(policy, Number.NaN)).toBe(0);
  });

  test('a fractional attempt truncates, where it used to be raised to a fractional power', () => {
    // Was 2_828 (1_000 * 2 ** 1.5). Every real caller passes the row’s integer attempt.
    expect(backoffDelayMs(policy, 2.5)).toBe(2_000);
  });

  test('a negative maxDelay is 0, where it used to be a negative delay', () => {
    expect(backoffDelayMs({ ...policy, maxDelay: -5 }, 1)).toBe(0);
  });

  test('a negative attempt is still the base delay, exactly as before', () => {
    expect(backoffDelayMs(policy, -3)).toBe(1_000);
    expect(backoffDelayMs(policy, 0)).toBe(1_000);
  });
});
