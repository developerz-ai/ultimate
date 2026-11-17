// What `formatMoney` shows a person, typed back, reads as the amount shown: the CURRENCY format's
// separators, grouping, code and symbols — and plain numbers still read, without one text ever
// meaning two amounts.

import { describe, expect, test } from 'bun:test';
import { formatMoney } from './format';
import { fromMinor } from './money';
import { parseAmount } from './parse-input';

const read = (text: string, locale: string, currency: string) =>
  parseAmount(text, { locale, currency });

const refusal = (text: string, locale: string, currency: string): string => {
  try {
    read(text, locale, currency);
  } catch (error) {
    expect(error).toBeUltimateError('X_MONEY_INPUT_INVALID');
    return String((error as { cause?: unknown }).cause);
  }
  return expect.unreachable(`${text} in ${locale} was read, and must be refused`);
};

describe('parseAmount reads the currency format', () => {
  test('a de-AT person types the amount as every de-AT price shows it', () => {
    // CLDR: de-AT groups a plain number with a no-break space, a currency amount with `.`.
    expect(read('1.234,56', 'de-AT', 'EUR')).toEqual({ minor: 123_456, currency: 'EUR' });
    expect(read('€ 1.234,56', 'de-AT', 'EUR')).toEqual({ minor: 123_456, currency: 'EUR' });
  });

  test.each([
    ['de-AT', 'EUR'],
    ['fr-CH', 'CHF'],
    ['mr-IN', 'INR'],
    ['en-CH', 'CHF'],
  ])('formatMoney in %s as %s reads back', (locale, currency) => {
    const money = fromMinor(123_456_789, currency);
    expect(read(formatMoney(money, locale), locale, currency)).toEqual(money);
    const negative = fromMinor(-123_456_789, currency);
    expect(read(formatMoney(negative, locale), locale, currency)).toEqual(negative);
  });

  test('the code display reads back even where the symbol is inside the code (en-ZA, R, ZAR)', () => {
    const money = fromMinor(123_456, 'ZAR');
    const shown = formatMoney(money, 'en-ZA', { display: 'code' });
    expect(read(shown, 'en-ZA', 'ZAR')).toEqual(money);
  });

  test.each([
    ['en-US', 'USD'],
    ['ar-AE', 'AED'],
    ['fr-CH', 'CHF'],
    ['en-ZA', 'ZAR'],
  ])('the accounting form in %s reads back as the negative it shows', (locale, currency) => {
    for (const display of ['symbol', 'code'] as const) {
      const money = fromMinor(-1, currency);
      const shown = formatMoney(money, locale, { display, accounting: true });
      expect(read(shown, locale, currency)).toEqual(money);
    }
  });

  test.each([
    ['en-CA', 'USD'],
    ['es-MX', 'USD'],
    ['de-AT', 'EUR'],
  ])('the narrow symbol in %s as %s reads back', (locale, currency) => {
    const money = fromMinor(123_456, currency);
    expect(read(formatMoney(money, locale, { display: 'narrowSymbol' }), locale, currency)).toEqual(
      money,
    );
  });
});

describe('both separator sets, never two amounts', () => {
  test.each([
    ["1'234,56", 'fr-CH'],
    ["1'234.56", 'fr-CH'],
    ['1 234,56', 'de-AT'],
    ['1.234,56', 'de-AT'],
    ['12,34,567.89', 'mr-IN'],
    ['1,234,567.89', 'mr-IN'],
  ])('%s in %s: the plain-number and the currency spelling agree', (text, locale) => {
    const currency = locale === 'mr-IN' ? 'INR' : locale === 'fr-CH' ? 'CHF' : 'EUR';
    const expected = locale === 'mr-IN' ? 123_456_789 : 123_456;
    expect(read(text, locale, currency)).toEqual({ minor: expected, currency });
  });

  test('where one set groups with the other one`s decimal (en-DE), the currency set alone reads', () => {
    // en-DE: plain `1.234,56`, currency `€1,234.56`. Reading both would make `1.234` one thousand
    // two hundred thirty-four and also one point two three four; the currency set wins.
    expect(read('€1,234.56', 'en-DE', 'EUR')).toEqual({ minor: 123_456, currency: 'EUR' });
    expect(refusal('1.234,56', 'en-DE', 'EUR')).toContain('groups digits after');
  });

  test('a mix of the two sets in one text is refused', () => {
    expect(refusal("1'234.567,8", 'fr-CH', 'CHF')).toContain('"');
    expect(refusal('1.234 567,89', 'de-AT', 'EUR')).toContain('is not part of a number');
  });

  test('parentheses are a sign only where the locale writes accounting with them', () => {
    expect(refusal('(1,00)', 'de-AT', 'EUR')).toContain('"("');
    expect(refusal('(-1.00)', 'en-US', 'USD')).toContain('sign');
    expect(refusal('(1.00', 'en-US', 'USD')).toContain('"("');
  });
});

describe('unit · a four-digit amount typed grouped, where the locale prints it ungrouped', () => {
  // CLDR's minimum grouping digits is 2 for `es` (and `pl`, `pt-PT`, …): `formatMoney` writes
  // `1234,56 €`, but a person types `1.234,56`. Both are the same amount; the grouped one was
  // refused once the parser grouped as each currency form prints (`examples/dummy`'s budget test).
  test('es: 1.234,56 and 1234,56 are both 1,234.56 EUR', () => {
    expect(parseAmount('1.234,56', { currency: 'EUR', locale: 'es' })).toEqual({
      minor: 123456,
      currency: 'EUR',
    });
    expect(parseAmount('1234,56', { currency: 'EUR', locale: 'es' })).toEqual({
      minor: 123456,
      currency: 'EUR',
    });
  });

  test('pl: 1 234,56 and 1234,56 are both 1,234.56 PLN', () => {
    expect(parseAmount('1\u00a0234,56', { currency: 'PLN', locale: 'pl' })).toEqual({
      minor: 123456,
      currency: 'PLN',
    });
    expect(parseAmount('1234,56', { currency: 'PLN', locale: 'pl' })).toEqual({
      minor: 123456,
      currency: 'PLN',
    });
  });

  test('a group in the wrong place is still refused', () => {
    expect(() => parseAmount('12.34,56', { currency: 'EUR', locale: 'es' })).toThrow(
      'X_MONEY_INPUT_INVALID',
    );
  });
});
