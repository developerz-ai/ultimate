// What a person types, read in their locale — and every reading two people would disagree on
// refused rather than guessed. No float anywhere: the answer is `fromDecimal`'s.

import { describe, expect, test } from 'bun:test';
import { parseAmount } from './parse-input';

const read = (text: string, locale: string, currency: string) =>
  parseAmount(text, { locale, currency });

describe('parseAmount', () => {
  test.each([
    ['1,234.56', 'en-US', 'USD', 123_456],
    ['1234.56', 'en-US', 'USD', 123_456],
    ['$1,234.56', 'en-US', 'USD', 123_456],
    ['1,234', 'en-US', 'USD', 123_400],
    ['-12.5', 'en-US', 'USD', -1_250],
    ['.5', 'en-US', 'USD', 50],
    ['1.234,56', 'de-DE', 'EUR', 123_456],
    ['1.234', 'de-DE', 'EUR', 123_400],
    ['12,5 €', 'de-DE', 'EUR', 1_250],
    ['1 234,56', 'fr-FR', 'EUR', 123_456],
    ['1 234,56', 'fr-FR', 'EUR', 123_456],
    ['12,34,567.89', 'hi-IN', 'INR', 123_456_789],
    ['١٬٢٣٤٫٥٦', 'ar-EG', 'EGP', 123_456],
    ['1,200', 'ja-JP', 'JPY', 1_200],
    ['￥1200', 'ja-JP', 'JPY', 1_200],
  ])('%s in %s as %s', (text, locale, currency, minor) => {
    expect(read(text, locale, currency)).toEqual({ minor, currency });
  });

  test.each([
    ['1,234', 'de-DE', 'EUR', 'has 2'],
    ['1.5', 'de-DE', 'EUR', 'does not group'],
    ['12,34', 'en-US', 'USD', 'does not group'],
    ['1,234.56', 'de-DE', 'EUR', 'groups digits after'],
    ['1.2.3', 'en-US', 'USD', 'appears twice'],
    ['12a', 'en-US', 'USD', '"a"'],
    ['1e3', 'en-US', 'USD', '"e"'],
    ['12.5', 'ja-JP', 'JPY', 'JPY has 0'],
    ['1.005', 'en-US', 'USD', 'USD has 2'],
    ['', 'en-US', 'USD', 'no digits'],
    ['€', 'de-DE', 'EUR', 'no digits'],
    ['1,234,56', 'hi-IN', 'INR', 'does not group'],
  ])('%s in %s is refused, never rounded or guessed', (text, locale, currency, reason) => {
    let caught: unknown;
    try {
      read(text, locale, currency);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_MONEY_INPUT_INVALID');
    expect(String((caught as { cause?: unknown }).cause)).toContain(reason);
  });

  test.each([12.5, undefined, null])('%p, not a string, is refused by code', (text) => {
    // A form posted as JSON hands over a number; `.trim()` on it was a bare TypeError, a 500.
    let caught: unknown;
    try {
      read(text as unknown as string, 'en-US', 'USD');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_MONEY_INPUT_INVALID');
    expect(String((caught as { cause?: unknown }).cause)).toContain('not text');
  });

  test('a locale or currency that is not one is refused by its own code', () => {
    expect(() => read('1', 'en_US', 'USD')).toThrow();
    expect(() => read('1', 'en-US', 'usd')).toThrow();
  });
});
