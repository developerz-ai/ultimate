// Owns one question `mfa.test.ts` never asked: what enrolment does when the recovery-code COUNT is
// not a count. `generateRecoveryCodes(NaN)` returned `{ codes: [], hashes: [] }` — a well-formed
// result enrolling a user with zero ways back into their account, which `redeemRecoveryCode` then
// answers `null` for every time.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable, type UltimateError } from '@ultimat3/core';
import { generateRecoveryCodes } from './mfa';

const caught = (fn: () => unknown): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable(`expected an UltimateError, got ${renderThrowable(thrown)}`);
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

/** `for (i = 0; i < NaN; i += 1)` never runs, and neither does `i < 0`. Both answer an empty set. */
const NOT_A_COUNT: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2.5,
  -1,
  0,
];

describe('generateRecoveryCodes count', () => {
  for (const count of NOT_A_COUNT) {
    test(`refuses ${String(count)} rather than enrolling zero codes`, () => {
      expect(caught(() => generateRecoveryCodes(count)).code).toBe('X_INVARIANT');
    });
  }

  test('the refusal names generateRecoveryCodes and count', () => {
    const error = caught(() => generateRecoveryCodes(Number.NaN));
    expect(error.cause).toContain('generateRecoveryCodes');
    expect(error.cause).toContain('count');
    expect(error.fix).not.toContain('defineAuth');
  });

  test('a real count still enrols — the non-vacuity half', () => {
    expect(generateRecoveryCodes().codes).toHaveLength(10);
    expect(generateRecoveryCodes(1).codes).toHaveLength(1);
    expect(generateRecoveryCodes(3).hashes).toHaveLength(3);
  });
});
