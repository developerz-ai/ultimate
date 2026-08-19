import { describe, expect, test } from 'bun:test';
import { ROUNDING_MODES, roundRatio, roundToDigits, roundToInteger } from './rounding';

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

  test('a negative value rounding to zero is 0, never -0', () => {
    // `sign * floor` with floor 0 produced `-0` in every mode. `JSON.stringify` writes it as `0`
    // while `Object.is` and any keyed `Map` see a different value — one amount, two identities.
    for (const mode of ROUNDING_MODES) {
      expect(Object.is(roundToInteger(-0.4, mode), -0)).toBe(false);
    }
    expect(Object.is(roundToDigits(-0.0001, 2, 'half-up'), -0)).toBe(false);
  });

  test('rounds to a digit count', () => {
    expect(roundToDigits(1.25, 1, 'half-up')).toBe(1.3);
    expect(roundToDigits(1.25, 1, 'half-even')).toBe(1.2);
    expect(roundToDigits(1.75, 1, 'half-even')).toBe(1.8);
  });

  test('rounds the decimal the caller wrote, not the float it scaled to', () => {
    // `roundToInteger(value * factor, mode)` is the bug this package documents as forbidden,
    // written again: `1.005 * 100` is 100.49999999999999, so half-up answered 1.00 — a 0.5% fee
    // billed as nothing, on the shortest-round-trip decimals a price list actually contains.
    expect(roundToDigits(1.005, 2, 'half-up')).toBe(1.01);
    expect(roundToDigits(1.005, 2, 'half-even')).toBe(1);
    expect(roundToDigits(1.015, 2, 'half-even')).toBe(1.02);
    expect(roundToDigits(-1.005, 2, 'half-up')).toBe(-1.01);
    expect(roundToDigits(1.005, 2, 'down')).toBe(1);
    expect(roundToDigits(1.0001, 2, 'up')).toBe(1.01);
    expect(roundToDigits(8.165, 2, 'half-up')).toBe(8.17);
  });

  test('refuses a digit count that names no decimal place', () => {
    expect(codeOf(() => roundToDigits(1.5, 1.5))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => roundToDigits(1.5, Number.NaN))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => roundToDigits(1.5, 16))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => roundToDigits(Number.POSITIVE_INFINITY, 2))).toBe('X_MONEY_NOT_INTEGER');
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

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
