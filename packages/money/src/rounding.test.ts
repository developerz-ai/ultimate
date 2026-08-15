import { describe, expect, test } from 'bun:test';
import { roundRatio, roundToDigits, roundToInteger } from './rounding';

describe('roundToInteger', () => {
  test('the modes disagree exactly at .5, which is the point', () => {
    expect(roundToInteger(2.5, 'half-up')).toBe(3);
    expect(roundToInteger(2.5, 'half-even')).toBe(2);
    expect(roundToInteger(3.5, 'half-even')).toBe(4);
    expect(roundToInteger(2.5, 'down')).toBe(2);
    expect(roundToInteger(2.1, 'up')).toBe(3);
  });

  test('is symmetric around zero — never let a refund round differently', () => {
    expect(roundToInteger(-2.5, 'half-up')).toBe(-3);
    expect(roundToInteger(-2.5, 'half-even')).toBe(-2);
    expect(roundToInteger(-2.5, 'down')).toBe(-2);
    expect(roundToInteger(-2.1, 'up')).toBe(-3);
  });

  test('rounds to a digit count', () => {
    // Binary-exact inputs only: a decimal like 1.2355 is already not itself as a float,
    // which is why money never goes through this path — minor units do.
    expect(roundToDigits(1.25, 1, 'half-up')).toBe(1.3);
    expect(roundToDigits(1.25, 1, 'half-even')).toBe(1.2);
    expect(roundToDigits(1.75, 1, 'half-even')).toBe(1.8);
  });
});

describe('roundRatio', () => {
  test('the modes disagree exactly at the half, on a value no float can hold', () => {
    // 1005/1000 of 100 is exactly 100.5. The float product is 100.49999999999999.
    expect(roundRatio(100_500n, 1000n, 'half-up')).toBe(101);
    expect(roundRatio(100_500n, 1000n, 'half-even')).toBe(100);
    expect(roundRatio(101_500n, 1000n, 'half-even')).toBe(102);
    expect(roundRatio(100_500n, 1000n, 'down')).toBe(100);
    expect(roundRatio(100_001n, 1000n, 'up')).toBe(101);
  });

  test('is symmetric around zero, whichever side carries the sign', () => {
    expect(roundRatio(-100_500n, 1000n, 'half-up')).toBe(-101);
    expect(roundRatio(100_500n, -1000n, 'half-up')).toBe(-101);
    expect(roundRatio(-100_500n, -1000n, 'half-up')).toBe(101);
    expect(roundRatio(-100_500n, 1000n, 'down')).toBe(-100);
  });

  test('an exact integer ratio needs no mode at all', () => {
    expect(roundRatio(9200n, 1n)).toBe(9200);
    expect(roundRatio(-9200n, 1n)).toBe(-9200);
  });

  test('a zero denominator is this package miswired, so it is X_INVARIANT', () => {
    let code = 'no-throw';
    try {
      roundRatio(1n, 0n);
    } catch (error) {
      code = (error as { code?: string }).code ?? 'no-code';
    }
    expect(code).toBe('X_INVARIANT');
  });
});
