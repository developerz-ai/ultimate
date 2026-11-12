// The duration parser is linear and length-capped: a pathological string is refused, never
// scanned quadratically (CodeQL js/polynomial-redos on the old sticky COMPONENT regex).

import { describe, expect, test } from 'bun:test';
import { MAX_DURATION_LENGTH, parseDuration } from './duration';

const zeros = '0'.repeat(50_000);

describe('parseDuration bounds its input', () => {
  for (const input of [zeros, `${zeros}x`, `${zeros}s`, `P${zeros}`, `PT${zeros}S`, `-${zeros}`]) {
    test(`a ${input.length}-char string is refused`, () => {
      expect(() => parseDuration(input)).toThrow(/X_DURATION_INVALID/);
    });
  }

  test('the cap is the boundary: the longest allowed form still parses', () => {
    const atCap = `${'0'.repeat(MAX_DURATION_LENGTH - 2)}1s`;
    expect(parseDuration(atCap)).toBe(1000);
    expect(() => parseDuration(`0${atCap}`)).toThrow(/X_DURATION_INVALID/);
  });

  test('surrounding whitespace does not count toward the cap', () => {
    expect(parseDuration(`   ${'0'.repeat(MAX_DURATION_LENGTH - 2)}1s   `)).toBe(1000);
  });

  test('alternation order is kept: ms before m, min before m, sec before s, hr before h', () => {
    expect(parseDuration('1ms')).toBe(1);
    expect(parseDuration('1min')).toBe(60_000);
    expect(parseDuration('1sec')).toBe(1000);
    expect(parseDuration('1hr')).toBe(3_600_000);
    expect(parseDuration('1 M 2 S')).toBe(62_000);
    expect(parseDuration('1.5h 30m')).toBe(7_200_000);
    expect(() => parseDuration('1mins')).toThrow(/X_DURATION_INVALID/);
    expect(() => parseDuration('.5s')).toThrow(/X_DURATION_INVALID/);
    expect(() => parseDuration('1.s')).toThrow(/X_DURATION_INVALID/);
    expect(() => parseDuration('1s2')).toThrow(/X_DURATION_INVALID/);
    expect(() => parseDuration('-')).toThrow(/X_DURATION_INVALID/);
    expect(() => parseDuration('- 3s')).toThrow(/X_DURATION_INVALID/);
  });
});
