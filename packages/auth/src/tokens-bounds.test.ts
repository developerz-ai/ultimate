// Owns one question `tokens.test.ts` never asked: what the function whose whole job is an
// unguessable secret does when the byte length it is handed is not a length. `randomToken(NaN)`
// answered `""` — a well-formed empty secret, no throw, no log — and `randomToken(-1)` threw a
// bare uncoded RangeError out of the package.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, renderThrowable, type UltimateError } from '@ultimat3/core';
import { randomToken } from './tokens';

const caught = (fn: () => unknown): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable(`expected an UltimateError, got ${renderThrowable(thrown)}`);
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

/**
 * `new Uint8Array(NaN)` is a zero-length array rather than a throw, so `base64Url` of it is `''`.
 * `Number(process.env.TOKEN_BYTES)` on an unset variable is exactly this value, and `??` cannot
 * stop it because `NaN` is not nullish. `0` is here for the same reason: a zero-byte token is the
 * empty string, which is not a secret that failed — it is no secret at all.
 */
const NOT_A_BYTE_LENGTH: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2.5,
  -1,
  0,
];

describe('randomToken byteLength', () => {
  for (const byteLength of NOT_A_BYTE_LENGTH) {
    test(`refuses ${String(byteLength)} rather than minting the empty string`, () => {
      expect(caught(() => randomToken(byteLength)).code).toBe('X_INVARIANT');
    });
  }

  test('the refusal names randomToken and byteLength — the call site, not defineAuth', () => {
    const error = caught(() => randomToken(Number.NaN));
    expect(error.cause).toContain('randomToken');
    expect(error.cause).toContain('byteLength');
    expect(error.fix).toContain('randomToken');
    // The edit is at the call site. `defineAuth` has no such key, and naming it would send the
    // reader to a file that cannot contain the fix.
    expect(error.fix).not.toContain('defineAuth');
  });

  test('every shipped length still mints — the non-vacuity half', () => {
    expect(randomToken()).toHaveLength(43);
    expect(randomToken(32)).toHaveLength(43);
    expect(randomToken(16)).toHaveLength(22);
    expect(randomToken(12)).toHaveLength(16);
    expect(randomToken(1)).not.toBe('');
  });
});
