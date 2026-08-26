// The repair `bun run finite-bounds` recognises, so its own contract has to hold: the refusal must
// name the option (that is what makes it ONE edit), the finite case must pass through unchanged
// (or every call site is broken), and a fraction must survive `finiteOption` and die in
// `finiteCount` — the two are different questions and a helper that conflated them would be a
// fourth copy of the rule rather than the end of it.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { finiteCount, finiteOption } from './finite-option';

const caught = (fn: () => unknown): UltimateError => {
  try {
    fn();
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
    return expect.unreachable(`expected an UltimateError, got ${String(thrown)}`);
  }
  return expect.unreachable('expected a refusal, nothing was thrown');
};

describe('finiteOption', () => {
  test('NaN is refused — the value `??` lets past and every comparison reads false against', () => {
    expect(caught(() => finiteOption('ChangeBuffer', 'capacity', Number.NaN)).code).toBe(
      'X_INVARIANT',
    );
  });

  test('both infinities are refused: a bound with no end is not a bound', () => {
    expect(
      caught(() => finiteOption('ChangeBuffer', 'capacity', Number.POSITIVE_INFINITY)).code,
    ).toBe('X_INVARIANT');
    expect(
      caught(() => finiteOption('ChangeBuffer', 'capacity', Number.NEGATIVE_INFINITY)).code,
    ).toBe('X_INVARIANT');
  });

  test('the refusal names the subject AND the option, which is what makes it one edit', () => {
    const error = caught(() => finiteOption('the sync node drain', 'graceMs', Number.NaN));
    expect(error.cause).toContain('the sync node drain');
    expect(error.cause).toContain('graceMs');
    expect(error.cause).toContain('NaN');
    expect(error.fix).toContain('graceMs');
    expect(error.fix).toContain('the sync node drain');
  });

  test('a finite value passes through unchanged — the non-vacuity half', () => {
    expect(finiteOption('ChangeBuffer', 'capacity', 1024)).toBe(1024);
    expect(finiteOption('ChangeBuffer', 'ratio', 0.25)).toBe(0.25);
    expect(finiteOption('ChangeBuffer', 'offset', -1)).toBe(-1);
    expect(finiteOption('ChangeBuffer', 'capacity', 0)).toBe(0);
  });
});

describe('finiteCount', () => {
  test('NaN, the infinities and a fraction are all refused', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5]) {
      expect(caught(() => finiteCount('createWorker', 'concurrency', value)).code).toBe(
        'X_INVARIANT',
      );
    }
  });

  test('a value past 2^53 is refused: a double there cannot name its own successor', () => {
    expect(caught(() => finiteCount('createWorker', 'concurrency', 2 ** 53)).code).toBe(
      'X_INVARIANT',
    );
  });

  test('zero passes by default and is refused when the caller says at least one', () => {
    expect(finiteCount('http', 'maxInflight', 0)).toBe(0);
    expect(caught(() => finiteCount('createPostgresClient', 'max', 0, 1)).code).toBe('X_INVARIANT');
    expect(caught(() => finiteCount('createPostgresClient', 'max', 0, 1)).cause).toContain(
      'at least 1',
    );
  });

  test('a negative is refused even at min 0, and a whole number passes through', () => {
    expect(caught(() => finiteCount('http', 'bodyLimitBytes', -1)).code).toBe('X_INVARIANT');
    expect(finiteCount('http', 'bodyLimitBytes', 1_048_576)).toBe(1_048_576);
  });
});
