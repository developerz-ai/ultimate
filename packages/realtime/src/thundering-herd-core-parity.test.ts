// Pins the one fact that makes `backoffDelay` safe to delegate: this package counts attempts from
// ZERO and core counts from ONE, so the mapping is `attempt + 1` and nothing else. Get it wrong
// and every reconnect delay in the framework doubles, silently and only under load.

import { describe, expect, test } from 'bun:test';
import { backoffDelay as coreBackoffDelay } from '@ultimat3/core';
import type { BackoffPolicy, JitterMode } from './thundering-herd';
import { backoffDelay, defaultBackoff } from './thundering-herd';

const none: BackoffPolicy = { ...defaultBackoff, jitter: 'none' };

describe('the 0-based attempt', () => {
  test('attempt 0 is the BASE delay, and attempt n is core’s attempt n+1', () => {
    // The numbers, spelled out: a doubled schedule ([1_000, 2_000, 4_000, 8_000]) is the exact
    // damage a lost `+ 1` does, and it is what this list refuses.
    expect([0, 1, 2, 3].map((attempt) => backoffDelay(attempt, none))).toEqual([
      500, 1_000, 2_000, 4_000,
    ]);
    expect(backoffDelay(0, none)).toBe(defaultBackoff.baseMs);
  });

  test('every attempt matches core at attempt + 1', () => {
    for (const attempt of [0, 1, 2, 3, 5, 7, 12, 99]) {
      expect(backoffDelay(attempt, none)).toBe(
        coreBackoffDelay({
          attempt: attempt + 1,
          base: none.baseMs,
          max: none.maxMs,
          factor: none.factor,
          curve: 'exponential',
          jitter: 'none',
        }),
      );
    }
  });

  test('a negative attempt is the base delay, exactly as before', () => {
    // `Math.max(0, attempt)` here became `Math.max(1, trunc(attempt))` one tier down; both floor
    // at the base, and a reconnect counter never goes below zero anyway.
    expect(backoffDelay(-1, none)).toBe(500);
    expect(backoffDelay(-7, none)).toBe(500);
  });
});

describe('backoffDelay is core backoffDelay', () => {
  test('every jitter mode, base, cap, factor, attempt and roll agrees to the millisecond', () => {
    const modes: readonly JitterMode[] = ['none', 'equal', 'full'];
    const bases: readonly number[] = [1, 7, 500, 1_000, 30_000];
    const caps: readonly number[] = [1, 999, 30_000, 3_600_000];
    const factors: readonly number[] = [1.5, 2, 3];
    const rolls: readonly number[] = [0, 0.1, 0.25, 1 / 3, 0.5, 0.7331, 0.999, 1];

    let compared = 0;
    for (const jitter of modes) {
      for (const baseMs of bases) {
        for (const maxMs of caps) {
          for (const factor of factors) {
            for (let attempt = 0; attempt < 12; attempt += 1) {
              for (const roll of rolls) {
                expect(backoffDelay(attempt, { baseMs, maxMs, factor, jitter }, () => roll)).toBe(
                  coreBackoffDelay({
                    attempt: attempt + 1,
                    base: baseMs,
                    max: maxMs,
                    factor,
                    curve: 'exponential',
                    jitter,
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
    // A grid that degenerates to zero comparisons is a green test that proves nothing.
    expect(compared).toBe(17_280);
  });

  test('the cap lands BEFORE the jitter, as it always did here', () => {
    // Raw at attempt 11 is 500 * 2 ** 11 = 1_024_000; capped to 30_000 first, so full jitter
    // spans [0, 30_000] rather than collapsing its upper half onto one value.
    expect(backoffDelay(11, defaultBackoff, () => 0)).toBe(0);
    expect(backoffDelay(11, defaultBackoff, () => 1)).toBe(30_000);
    expect(backoffDelay(11, defaultBackoff, () => 0.5)).toBe(15_000);
  });

  test('the default policy is still full jitter from 500ms to 30s, factor 2', () => {
    expect(defaultBackoff).toEqual({ baseMs: 500, maxMs: 30_000, factor: 2, jitter: 'full' });
    // `full` reaches zero; `equal` never does. The mapping must not quietly become the other one.
    expect(backoffDelay(3, defaultBackoff, () => 0)).toBe(0);
    expect(backoffDelay(3, { ...defaultBackoff, jitter: 'equal' }, () => 0)).toBe(2_000);
  });
});
