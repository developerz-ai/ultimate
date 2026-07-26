import { describe, expect, test } from 'bun:test';
import { roundToDigits, roundToInteger } from './rounding';

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
