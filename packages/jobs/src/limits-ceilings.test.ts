// The four ceilings `createLimiter` ENFORCES, refused when the number is not one. Each is read as
// `config.x !== undefined && count >= config.x`, so the option is present and the comparison is
// false forever: the ceiling stops existing while `snapshot().config` still reports the number an
// operator configured. Measured before the screen, on `createLimiter({ global: Number(process.env
// .WORKER_GLOBAL_CONCURRENCY) })` with the variable unset — 1000 of 1000 acquires granted, where
// `global: 2` grants 2.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { createLimiter } from './limits';

/** Every shape `Number(...)` / `parseInt` / JSON hands a config reader that no `??` can catch. */
const NOT_A_CEILING: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

const fixOf = (thrown: unknown): string =>
  thrown instanceof UltimateError ? `${thrown.code} ${thrown.cause} ${thrown.fix}` : '';

const thrownBy = (build: () => unknown): unknown => {
  try {
    build();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

/** How many of `attempts` a limiter actually grants — the number the ceiling is supposed to cap. */
const granted = (config: Parameters<typeof createLimiter>[0], attempts: number): number => {
  const limiter = createLimiter(config);
  let count = 0;
  for (let index = 0; index < attempts; index += 1) {
    if (limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' }) !== undefined) count += 1;
  }
  return count;
};

describe('a limiter built on a number that is not a ceiling', () => {
  test('a non-finite global is refused, not a process with no global ceiling at all', () => {
    for (const global of NOT_A_CEILING) {
      const thrown = thrownBy(() => createLimiter({ global }));
      expect(thrown).toBeInstanceOf(UltimateError);
      // Names the knob the operator wrote, so the refusal is an instruction and not a riddle.
      expect(fixOf(thrown)).toContain('global');
      expect(fixOf(thrown)).toContain('X_INVARIANT');
    }
  });

  test('a non-finite perQueue is refused', () => {
    for (const perQueue of NOT_A_CEILING) {
      const thrown = thrownBy(() => createLimiter({ perQueue }));
      expect(thrown).toBeInstanceOf(UltimateError);
      expect(fixOf(thrown)).toContain('perQueue');
    }
  });

  test('a non-finite perTenant is refused, not one tenant taking every slot in the pod', () => {
    for (const perTenant of NOT_A_CEILING) {
      const thrown = thrownBy(() => createLimiter({ perTenant }));
      expect(thrown).toBeInstanceOf(UltimateError);
      expect(fixOf(thrown)).toContain('perTenant');
    }
  });

  test('both halves of ratePerTenant are refused, and each names its own half', () => {
    // The window is as load-bearing as the count: `stamp > at - NaN` is false for every stamp, so
    // the window reads EMPTY on every call and `window.length >= rate.limit` never holds — a rate
    // limit that is off with a `limit` an operator can read in `/_x`.
    for (const value of NOT_A_CEILING) {
      const onLimit = thrownBy(() =>
        createLimiter({ ratePerTenant: { limit: value, windowMs: 1_000 } }),
      );
      expect(fixOf(onLimit)).toContain('ratePerTenant.limit');
      expect(fixOf(onLimit)).not.toContain('windowMs');

      const onWindow = thrownBy(() =>
        createLimiter({ ratePerTenant: { limit: 5, windowMs: value } }),
      );
      expect(fixOf(onWindow)).toContain('ratePerTenant.windowMs');
    }
  });

  test('a fraction and a negative are refused too — a ceiling counts slots', () => {
    // `global: 2.5` granted 3 (the comparison rounds UP), and `global: -1` refused everything
    // while reading as a configured ceiling of minus one.
    expect(thrownBy(() => createLimiter({ global: 2.5 }))).toBeInstanceOf(UltimateError);
    expect(thrownBy(() => createLimiter({ perTenant: -1 }))).toBeInstanceOf(UltimateError);
  });
});

describe('the guard refuses numbers, not limiters', () => {
  // Non-vacuity: a screen that threw on everything, or one that refused a legitimate zero, would
  // pass every assertion above. Zero is a HARD STOP here and always has been — never "unlimited",
  // which is what omitting the option means — and `limits-bound.test.ts` already relies on it.
  test('zero is a ceiling of zero, kept', () => {
    expect(granted({ perTenant: 0 }, 5)).toBe(0);
    expect(granted({ global: 0 }, 5)).toBe(0);
    expect(granted({ perQueue: 0 }, 5)).toBe(0);
  });

  test('a real ceiling still caps, and the uncapped limiter still grants', () => {
    expect(granted({ global: 2 }, 1_000)).toBe(2);
    expect(granted({ perTenant: 3 }, 1_000)).toBe(3);
    expect(granted({ perQueue: 4 }, 1_000)).toBe(4);
    expect(granted({ ratePerTenant: { limit: 5, windowMs: 1_000 } }, 1_000)).toBe(5);
    expect(granted({}, 1_000)).toBe(1_000);
  });
});
