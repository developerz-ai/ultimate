import { describe, expect, test } from 'bun:test';
import { CURRENCIES, currencyInfo, exponentOf, isValidCurrency, scaleOf } from './currency';

describe('currency table', () => {
  test('exponents match ISO-4217 for the currencies that trip people up', () => {
    expect(exponentOf('USD')).toBe(2);
    expect(exponentOf('EUR')).toBe(2);
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KRW')).toBe(0);
    expect(exponentOf('VND')).toBe(0);
    expect(exponentOf('ISK')).toBe(0);
    expect(exponentOf('KWD')).toBe(3);
    expect(exponentOf('BHD')).toBe(3);
    expect(exponentOf('OMR')).toBe(3);
    expect(exponentOf('TND')).toBe(3);
  });

  test('scale is derived, never assumed', () => {
    expect(scaleOf('EUR')).toBe(100);
    expect(scaleOf('JPY')).toBe(1);
    expect(scaleOf('KWD')).toBe(1000);
  });

  test('the table is well formed', () => {
    const codes = CURRENCIES.map((info) => info.code);
    expect(new Set(codes).size).toBe(codes.length); // no duplicates
    expect(codes).toEqual([...codes].sort()); // sorted, so diffs stay readable
    for (const info of CURRENCIES) {
      expect(info.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2, 3]).toContain(info.exponent);
      // Intl must know every code we claim to support.
      expect(() =>
        new Intl.NumberFormat('en-US', { style: 'currency', currency: info.code }).format(1),
      ).not.toThrow();
    }
  });

  test('unknown codes are loud', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('usd')).toBe(false);
    expect(isValidCurrency('BTC')).toBe(false);
    expect(codeOf(() => currencyInfo('XYZ'))).toBe('X_CURRENCY_UNKNOWN');
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
