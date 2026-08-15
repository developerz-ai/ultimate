import { describe, expect, test } from 'bun:test';
import {
  equals,
  formatMoneyDebug,
  fromDecimal,
  isMoney,
  money,
  toDecimalNumber,
  toDecimalString,
  zero,
} from './money';

describe('money', () => {
  test('rejects a fractional minor amount with X_MONEY_NOT_INTEGER', () => {
    expect(codeOf(() => money(12.5, 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
    expect(codeOf(() => money(Number.NaN, 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
    expect(money(1299, 'EUR')).toEqual({ minor: 1299, currency: 'EUR' });
  });

  test('rejects an unknown currency', () => {
    expect(codeOf(() => money(100, 'XYZ'))).toBe('X_CURRENCY_UNKNOWN');
    expect(codeOf(() => money(100, 'eur'))).toBe('X_CURRENCY_UNKNOWN');
  });
});

describe('fromDecimal', () => {
  test('scales by the currency exponent, not by 100', () => {
    expect(fromDecimal('12.99', 'EUR').minor).toBe(1299);
    expect(fromDecimal('1200', 'JPY').minor).toBe(1200);
    expect(fromDecimal('1.234', 'KWD').minor).toBe(1234);
    expect(fromDecimal('0.5', 'USD').minor).toBe(50);
    expect(fromDecimal('-3.07', 'USD').minor).toBe(-307);
  });

  test('never goes through a float', () => {
    // 0.1 + 0.2 style drift: 8.87 * 100 is 886.9999… in binary floating point.
    expect(fromDecimal('8.87', 'USD').minor).toBe(887);
    expect(fromDecimal('1.005', 'KWD').minor).toBe(1005);
    expect(fromDecimal('184467440737.09', 'USD').minor).toBe(18446744073709);
  });

  test('excess precision throws unless rounding is explicit', () => {
    expect(codeOf(() => fromDecimal('12.999', 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
    expect(fromDecimal('12.999', 'EUR', { rounding: 'half-up' }).minor).toBe(1300);
    expect(fromDecimal('12.999', 'EUR', { rounding: 'down' }).minor).toBe(1299);
    expect(fromDecimal('1200.4', 'JPY', { rounding: 'half-up' }).minor).toBe(1200);
  });

  test('rejects formatted input instead of guessing', () => {
    expect(codeOf(() => fromDecimal('1,299.00', 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
    expect(codeOf(() => fromDecimal('€12.99', 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
    expect(codeOf(() => fromDecimal('1e3', 'EUR'))).toBe('X_MONEY_NOT_INTEGER');
  });
});

describe('toDecimalString', () => {
  test('round-trips for 0-, 2- and 3-digit currencies', () => {
    expect(toDecimalString(money(1299, 'EUR'))).toBe('12.99');
    expect(toDecimalString(money(5, 'EUR'))).toBe('0.05');
    expect(toDecimalString(money(-5, 'EUR'))).toBe('-0.05');
    expect(toDecimalString(money(1200, 'JPY'))).toBe('1200');
    expect(toDecimalString(money(1234, 'KWD'))).toBe('1.234');
    expect(toDecimalString(zero('USD'))).toBe('0.00');
    for (const [value, currency] of [
      ['12.99', 'EUR'],
      ['1200', 'JPY'],
      ['1.234', 'KWD'],
      ['0.001', 'BHD'],
    ] as const) {
      expect(toDecimalString(fromDecimal(value, currency))).toBe(value);
    }
  });
});

describe('isMoney', () => {
  test('guards untrusted input', () => {
    expect(isMoney({ minor: 100, currency: 'USD' })).toBe(true);
    expect(isMoney({ minor: 1.5, currency: 'USD' })).toBe(false);
    expect(isMoney({ minor: 100 })).toBe(false);
    expect(isMoney(null)).toBe(false);
  });

  test('a scale is optional, and an unusable one is not money', () => {
    expect(isMoney({ minor: 2, currency: 'USD', scale: 6 })).toBe(true);
    expect(isMoney({ minor: 2, currency: 'USD', scale: 6.5 })).toBe(false);
    expect(isMoney({ minor: 2, currency: 'USD', scale: -1 })).toBe(false);
    expect(isMoney({ minor: 2, currency: 'USD', scale: '6' })).toBe(false);
  });
});

describe('a money value at a scale of its own', () => {
  test('the constructor takes one, and omits the key at the currency’s own scale', () => {
    expect(money(2, 'USD', 6)).toEqual({ minor: 2, currency: 'USD', scale: 6 });
    // Canonical: one encoding per value at the natural scale, so existing JSON is untouched.
    expect(JSON.stringify(money(1299, 'EUR', 2))).toBe('{"minor":1299,"currency":"EUR"}');
    expect(codeOf(() => money(2, 'USD', 2.5))).toBe('X_MONEY_SCALE_INVALID');
  });

  test('equals compares the value, not the encoding', () => {
    expect(equals(money(1299, 'EUR'), money(12_990_000, 'EUR', 6))).toBe(true);
    expect(equals(money(1299, 'EUR'), money(12_990_001, 'EUR', 6))).toBe(false);
    expect(equals(money(1299, 'EUR'), money(1299, 'USD'))).toBe(false);
  });

  test('the decimal projections read the value’s own scale, never the currency’s', () => {
    expect(toDecimalString(money(2, 'USD', 6))).toBe('0.000002');
    expect(toDecimalString(money(-2, 'USD', 6))).toBe('-0.000002');
    expect(toDecimalNumber(money(2, 'USD', 6))).toBe(0.000002);
    expect(formatMoneyDebug(money(2, 'USD', 6))).toBe('USD 2e-6');
    // Unchanged for every value that carries no scale.
    expect(formatMoneyDebug(money(1299, 'EUR'))).toBe('EUR 1299');
  });

  test('fromDecimal accepts the extra digits when a scale is named for them', () => {
    expect(codeOf(() => fromDecimal('0.000002', 'USD'))).toBe('X_MONEY_NOT_INTEGER');
    expect(fromDecimal('0.000002', 'USD', { scale: 6 })).toEqual({
      minor: 2,
      currency: 'USD',
      scale: 6,
    });
    expect(toDecimalString(fromDecimal('0.000002', 'USD', { scale: 6 }))).toBe('0.000002');
    // A scale coarser than the digits still needs an explicit rounding mode.
    expect(codeOf(() => fromDecimal('0.0000025', 'USD', { scale: 6 }))).toBe('X_MONEY_NOT_INTEGER');
    expect(fromDecimal('0.0000025', 'USD', { scale: 6, rounding: 'half-up' }).minor).toBe(3);
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
