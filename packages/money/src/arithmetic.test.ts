import { describe, expect, test } from 'bun:test';
import { add, compare, isZero, max, multiply, negate, subtract, sum } from './arithmetic';
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
