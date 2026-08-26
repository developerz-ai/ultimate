// The agreement `toDurationMs` and `@ultimat3/time`'s `toMs` have to keep: one duration
// vocabulary, one answer per input. They disagreed once (#372) — the copy refused a NaN and the
// original passed it through — and only a test that calls BOTH can see it come back.

import { describe, expect, test } from 'bun:test';
import { toMs } from '@ultimat3/time';
import { toDurationMs } from './plan';

const NOT_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('notify and time answer the same input the same way', () => {
  for (const value of NOT_FINITE) {
    test(`${String(value)} is refused by both, never by one of them`, () => {
      expect(() => toMs(value)).toThrow(/X_INVARIANT/);
      expect(() => toDurationMs(value)).toThrow(/X_INVARIANT/);
    });
  }

  test('every string form answers identically', () => {
    for (const spelling of ['15m', '1h', '250ms', 'PT2H30M', '3d']) {
      expect(toDurationMs(spelling)).toBe(toMs(spelling));
    }
  });
});

describe('what notify narrows on top, and why the narrowing lives here', () => {
  // `time` is the framework's duration vocabulary and a negative one is real there — a diff
  // between two instants, `toSeconds(-3000)`. In a notifier it is not: a negative `wait` never
  // elapses and a negative digest `window` closes before it opens.
  test('a negative is a duration in time and a mistake in a notifier', () => {
    expect(toMs(-1000)).toBe(-1000);
    expect(() => toDurationMs(-1000, 'deliver[email].wait')).toThrow(/X_INVARIANT/);
  });

  test('a fraction of a millisecond is the same split', () => {
    expect(toMs(1.5)).toBe(1.5);
    expect(() => toDurationMs(1.5, 'deliver[email].wait')).toThrow(/X_INVARIANT/);
  });

  test('the refusal names which declaration was wrong, since one notifier holds several', () => {
    expect(() => toDurationMs(Number.NaN, 'deliver[email].digest.window')).toThrow(
      /deliver\[email\]\.digest\.window/,
    );
  });

  test('zero is a declaration, not a mistake: no wait at all', () => {
    expect(toDurationMs(0, 'deliver[email].wait')).toBe(0);
    expect(toDurationMs('0s')).toBe(0);
  });
});
