import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { type MoneyFormatter, moneyText, toMoney } from './money-view';

// A stub formatter proves the locale and currency reached @ultimat3/money rather
// than being resolved from a process-wide default.
const calls: Array<{ minor: number; currency: string; locale: string }> = [];
const format: MoneyFormatter = (amount, locale) => {
  calls.push({ minor: amount.minor, currency: amount.currency, locale });
  return `${locale}:${amount.currency}:${amount.minor}`;
};

describe('moneyText', () => {
  test('formats through the injected locale, not an ambient default', () => {
    calls.length = 0;
    const out = moneyText({
      value: { minor: 129900, currency: 'EUR' },
      locale: 'de-DE',
      currency: 'USD',
      format,
    });
    expect(out).toBe('de-DE:EUR:129900');
    expect(calls[0]).toEqual({ minor: 129900, currency: 'EUR', locale: 'de-DE' });
  });

  test('the same value renders differently per injected locale', () => {
    const value = { minor: 500, currency: 'JPY' };
    expect(moneyText({ value, locale: 'en-US', currency: 'USD', format })).toBe('en-US:JPY:500');
    expect(moneyText({ value, locale: 'ja-JP', currency: 'USD', format })).toBe('ja-JP:JPY:500');
  });

  test('a bare number takes the injected context currency', () => {
    expect(toMoney(2500, 'GBP')).toEqual({ minor: 2500, currency: 'GBP' });
    expect(moneyText({ value: 2500, locale: 'en-GB', currency: 'GBP', format })).toBe(
      'en-GB:GBP:2500',
    );
  });

  test('the real formatter is reached when none is injected', () => {
    const text = moneyText({
      value: { minor: 129900, currency: 'EUR' },
      locale: 'de-DE',
      currency: 'EUR',
    });
    expect(text).toContain('1.299');
  });

  test('a float is rejected — money is never a float', () => {
    try {
      toMoney(19.99, 'USD');
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string };
      expect(err.code).toBe(UI_ERROR_CODES.invalidValue);
      expect(String(err.cause)).toContain('minor units');
    }
  });
});
