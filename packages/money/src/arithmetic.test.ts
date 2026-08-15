import { describe, expect, test } from 'bun:test';
import { add, compare, divide, isZero, max, multiply, negate, subtract, sum } from './arithmetic';
import { money } from './money';

describe('cross-currency safety', () => {
  test('add refuses two currencies with X_CURRENCY_MISMATCH', () => {
    const usd = money(1000, 'USD');
    const eur = money(1000, 'EUR');
    expect(codeOf(() => add(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => subtract(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => compare(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    expect(codeOf(() => max(usd, eur))).toBe('X_CURRENCY_MISMATCH');
    // The mismatch error must name both sides so the fix is obvious.
    expect(causeOf(() => add(usd, eur))).toContain('USD');
    expect(causeOf(() => add(usd, eur))).toContain('EUR');
  });

  test('sum over a mixed list throws instead of producing a plausible number', () => {
    const amounts = [money(100, 'USD'), money(200, 'USD'), money(300, 'JPY')];
    expect(codeOf(() => sum(amounts))).toBe('X_CURRENCY_MISMATCH');
    expect(sum([money(100, 'USD'), money(200, 'USD')])).toEqual({
      minor: 300,
      currency: 'USD',
    });
    expect(sum([], 'JPY')).toEqual({ minor: 0, currency: 'JPY' });
    expect(codeOf(() => sum([]))).toBe('X_CURRENCY_UNKNOWN');
  });
});

describe('integer arithmetic', () => {
  test('add and subtract stay exact', () => {
    expect(add(money(10, 'USD'), money(20, 'USD')).minor).toBe(30);
    expect(subtract(money(10, 'USD'), money(20, 'USD')).minor).toBe(-10);
    expect(isZero(subtract(money(10, 'USD'), money(10, 'USD')))).toBe(true);
    expect(negate(money(10, 'USD')).minor).toBe(-10);
  });

  test('multiply rounds with the mode the caller names', () => {
    const price = money(1999, 'USD'); // $19.99
    // 19% VAT: 1999 * 0.19 = 379.81 minor units
    expect(multiply(price, 0.19, 'half-up').minor).toBe(380);
    expect(multiply(price, 0.19, 'down').minor).toBe(379);
    // exact .5 is where modes disagree: 1005 * 0.5 = 502.5
    expect(multiply(money(1005, 'USD'), 0.5, 'half-up').minor).toBe(503);
    expect(multiply(money(1005, 'USD'), 0.5, 'half-even').minor).toBe(502);
    expect(multiply(money(-1005, 'USD'), 0.5, 'half-up').minor).toBe(-503);
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

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}

describe('scaling is exact, not an IEEE-754 product', () => {
  // `100 * 1.005` is 100.49999999999999, so multiplying first hid the exact 100.5 from `half-up`
  // and a 0.5% fee on €1.00 was billed as nothing.
  test('multiply rounds the value written, not the value the double holds', () => {
    expect(multiply(money(100, 'EUR'), 1.005)).toEqual({ minor: 101, currency: 'EUR' });
    expect(multiply(money(100, 'EUR'), 1.005, 'down')).toEqual({ minor: 100, currency: 'EUR' });
    expect(multiply(money(100, 'EUR'), 1.005, 'half-even')).toEqual({
      minor: 100,
      currency: 'EUR',
    });
  });

  test('multiply stays symmetric around zero at the exact half', () => {
    expect(multiply(money(-100, 'EUR'), 1.005)).toEqual({ minor: -101, currency: 'EUR' });
    expect(multiply(money(-100, 'EUR'), 1.005, 'down')).toEqual({ minor: -100, currency: 'EUR' });
  });

  test('a factor in exponent notation carries its own decimal expansion', () => {
    expect(multiply(money(1_000_000, 'EUR'), 1e-4)).toEqual({ minor: 100, currency: 'EUR' });
    expect(multiply(money(2, 'EUR'), 2.5e2)).toEqual({ minor: 500, currency: 'EUR' });
  });

  test('divide rounds the exact quotient', () => {
    expect(divide(money(1000, 'EUR'), 3)).toEqual({ minor: 333, currency: 'EUR' });
    expect(divide(money(1, 'EUR'), 2)).toEqual({ minor: 1, currency: 'EUR' });
    expect(divide(money(1, 'EUR'), 2, 'half-even')).toEqual({ minor: 0, currency: 'EUR' });
    expect(divide(money(-1, 'EUR'), 2)).toEqual({ minor: -1, currency: 'EUR' });
    // Scaling by 0.1 and dividing by 10 are the same question and must not answer differently.
    expect(divide(money(105, 'EUR'), 10)).toEqual(multiply(money(105, 'EUR'), 0.1));
  });

  test('an amount scaled past the safe-integer range is refused, never approximated', () => {
    expect(codeOf(() => multiply(money(1_000_000_000, 'EUR'), 1e9))).toBe('X_MONEY_NOT_INTEGER');
  });
});
