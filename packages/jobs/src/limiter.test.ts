// `limiter()` refuses, where it is written, every declaration no worker can honour — and a second
// declaration of one name with different numbers, which would share lease rows and disagree.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { job, resetJobs } from './job';
import type { LimiterOptions } from './limiter';
import { limiter, MAX_LIMITER_RATE, resetLimiters } from './limiter';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-coded';
  }
  return undefined;
};

afterEach(() => {
  resetLimiters();
  resetJobs();
});

describe('limiter()', () => {
  test('a declaration is frozen data naming its numbers', () => {
    const vendor = limiter('vendor', { rate: { limit: 10, windowMs: 1_000 }, concurrency: 4 });
    expect(vendor).toEqual({
      kind: 'limiter',
      name: 'vendor',
      rate: { limit: 10, windowMs: 1_000 },
      concurrency: 4,
    });
    expect(Object.isFrozen(vendor)).toBe(true);
    expect(Object.isFrozen(vendor.rate)).toBe(true);
  });

  const refused: readonly (readonly [string, string, LimiterOptions])[] = [
    ['nothing', 'vendor', {}],
    ['concurrency 0', 'vendor', { concurrency: 0 }],
    ['concurrency 1.5', 'vendor', { concurrency: 1.5 }],
    ['concurrency NaN', 'vendor', { concurrency: Number.NaN }],
    ['rate.limit 0', 'vendor', { rate: { limit: 0, windowMs: 1_000 } }],
    [
      'rate.limit past the ceiling',
      'vendor',
      { rate: { limit: MAX_LIMITER_RATE + 1, windowMs: 1 } },
    ],
    [
      'rate.windowMs Infinity',
      'vendor',
      { rate: { limit: 1, windowMs: Number.POSITIVE_INFINITY } },
    ],
    ['an empty name', '', { concurrency: 1 }],
    ['a name with a space', 'my vendor', { concurrency: 1 }],
  ];
  for (const [label, name, options] of refused) {
    test(`${label} is X_JOB_DECLARATION_INVALID`, () => {
      expect(codeOf(() => limiter(name, options))).toBe('X_JOB_DECLARATION_INVALID');
    });
  }

  test('one name declared twice is one budget when the numbers agree, and refused when not', () => {
    limiter('vendor', { concurrency: 2 });
    expect(codeOf(() => limiter('vendor', { concurrency: 2 }))).toBeUndefined();
    expect(codeOf(() => limiter('vendor', { concurrency: 3 }))).toBe('X_JOB_DECLARATION_INVALID');
  });

  test('job({ limiter }) refuses a value limiter() did not build', () => {
    const lookalike = { kind: 'nope', name: 'vendor', rate: undefined, concurrency: 1 } as never;
    expect(
      codeOf(() =>
        job({
          tenant: 'none',
          input: t.object({}),
          idempotencyKey: () => 'k',
          retry: { attempts: 1 },
          limiter: lookalike,
          run: async () => undefined,
        }),
      ),
    ).toBe('X_JOB_DECLARATION_INVALID');
  });
});
