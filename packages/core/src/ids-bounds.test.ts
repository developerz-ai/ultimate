// Owns one question `ids.test.ts` never asked: what an id generator does when the LENGTH it is
// given is not a length. `nanoid(NaN)` and `randomHex(NaN)` both answered the empty string — a
// generator whose whole job is unguessability returning nothing, with no throw and no log.

import { describe, expect, test } from 'bun:test';
import { renderThrowable } from './error-render';
import { isUltimateError, type UltimateError } from './errors';
import { nanoid, randomHex } from './ids';

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
 * `new Uint8Array(NaN)` is a zero-length array rather than a throw, so every one of these produced
 * a well-formed empty string. `Number(process.env.ID_LENGTH)` on an unset variable is the value
 * that gets here, and `??` cannot stop it because `NaN` is not nullish.
 */
const NOT_A_LENGTH: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2.5,
  -1,
  0,
];

describe('nanoid length', () => {
  for (const length of NOT_A_LENGTH) {
    test(`refuses ${String(length)} rather than answering the empty string`, () => {
      expect(caught(() => nanoid(length)).code).toBe('X_INVARIANT');
    });
  }

  test('the refusal names the parameter the caller passes, so it is one edit', () => {
    const error = caught(() => nanoid(Number.NaN));
    expect(error.cause).toContain('nanoid');
    expect(error.cause).toContain('length');
  });

  test('a real length still works — the non-vacuity half', () => {
    expect(nanoid()).toHaveLength(21);
    expect(nanoid(1)).toHaveLength(1);
    expect(nanoid(64)).toHaveLength(64);
  });
});

describe('randomHex byteLength', () => {
  for (const byteLength of NOT_A_LENGTH) {
    test(`refuses ${String(byteLength)} rather than answering the empty string`, () => {
      expect(caught(() => randomHex(byteLength)).code).toBe('X_INVARIANT');
    });
  }

  test('a real byte length still works, and uuid()/traceId()/spanId() still mint', () => {
    expect(randomHex(1)).toMatch(/^[0-9a-f]{2}$/);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});
