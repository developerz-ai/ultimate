import { describe, expect, test } from 'bun:test';
import { money } from './money';
import { assertScale, MAX_MONEY_SCALE, minorAt, moneyScale } from './scale';

describe('moneyScale', () => {
  test('a value without a scale carries its currency’s own', () => {
    expect(moneyScale(money(1299, 'EUR'))).toBe(2);
    expect(moneyScale(money(1200, 'JPY'))).toBe(0);
    expect(moneyScale(money(1234, 'KWD'))).toBe(3);
  });

  test('an explicit scale wins, and is what makes a sub-cent amount expressible', () => {
    // The AI cost path's real number: $0.000002, which cents alone rounded up to a whole 1¢.
    expect(moneyScale({ minor: 2, currency: 'USD', scale: 6 })).toBe(6);
  });
});

describe('assertScale', () => {
  test('refuses a scale that names no decimal place with X_MONEY_SCALE_INVALID', () => {
    expect(codeOf(() => assertScale(-1))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => assertScale(2.5))).toBe('X_MONEY_SCALE_INVALID');
    expect(codeOf(() => assertScale(Number.NaN))).toBe('X_MONEY_SCALE_INVALID');
  });

  test('refuses a scale past 10^15, the last power of ten that is a safe integer', () => {
    expect(codeOf(() => assertScale(MAX_MONEY_SCALE + 1))).toBe('X_MONEY_SCALE_INVALID');
    expect(assertScale(MAX_MONEY_SCALE)).toBe(MAX_MONEY_SCALE);
    expect(assertScale(0)).toBe(0);
  });
});

describe('minorAt', () => {
  test('widens exactly, as a bigint, so a comparison never overflows a double', () => {
    expect(minorAt(money(1299, 'EUR'), 6)).toBe(12_990_000n);
    expect(minorAt({ minor: 2, currency: 'USD', scale: 6 }, 6)).toBe(2n);
    // Past 2^53: the point of the bigint. `money()` would refuse the widened value, a
    // comparison must not.
    expect(minorAt(money(Number.MAX_SAFE_INTEGER, 'USD'), 6)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) * 10_000n,
    );
  });

  test('refuses to narrow — that is a rounding decision, and rescale() owns it', () => {
    expect(codeOf(() => minorAt({ minor: 2, currency: 'USD', scale: 6 }, 2))).toBe(
      'X_MONEY_SCALE_INVALID',
    );
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
