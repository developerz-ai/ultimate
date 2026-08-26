// The bound `toMs` never had. Split from `duration.test.ts` so each file keeps one job: that one
// is about the duration VOCABULARY, this one is about the number arm that bypassed it.

import { describe, expect, test } from 'bun:test';
import { parseDuration, toMs, toSeconds } from './duration';

describe('toMs screens the number arm', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    test(`${String(value)} is refused, never passed through`, () => {
      expect(() => toMs(value)).toThrow(/X_INVARIANT/);
    });
  }

  test('the refusal names the duration, so a caller knows which argument was wrong', () => {
    expect(() => toMs(Number.NaN)).toThrow(/duration/);
  });

  // `Number(process.env.X)` on an unset variable is the way this arrives in production, and
  // `??` does not guard it: NaN is not nullish.
  test('an unset environment value is refused rather than becoming a bound nothing enforces', () => {
    const env: Record<string, string | undefined> = {};
    expect(() => toMs(Number(env['TTL_MS']))).toThrow(/X_INVARIANT/);
  });

  test('toSeconds inherits the screen, because it goes through toMs', () => {
    expect(() => toSeconds(Number.NaN)).toThrow(/X_INVARIANT/);
  });
});

describe('what the screen deliberately still accepts', () => {
  test('zero, negatives and fractions are all real durations here', () => {
    expect(toMs(0)).toBe(0);
    expect(toMs(-3000)).toBe(-3000);
    expect(toMs(1.5)).toBe(1.5);
    expect(Object.is(toMs(-0), -0)).toBe(true);
  });

  test('the string arm is unchanged, in both signs', () => {
    expect(toMs('90s')).toBe(90_000);
    expect(toMs('-1500ms')).toBe(parseDuration('-1500ms'));
    expect(toSeconds(-3000)).toBe(-3);
  });
});
