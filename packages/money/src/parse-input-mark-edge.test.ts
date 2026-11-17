// A currency mark is read only where an amount is written with one — before or after the number —
// never between its digits: `10€50` is no reading two people agree on, so it is refused, not
// joined into 1050. Every `formatMoney` display still reads back, signs included.

import { describe, expect, test } from 'bun:test';
import { formatMoney } from './format';
import { fromMinor } from './money';
import { parseAmount } from './parse-input';

const read = (text: string, locale: string, currency: string) =>
  parseAmount(text, { locale, currency });

describe('parseAmount · a mark inside the number', () => {
  test.each([
    ['10€50', 'fr-FR', 'EUR'],
    ['10€50', 'de-DE', 'EUR'],
    ['1$000', 'en-US', 'USD'],
    ['3R50', 'en-ZA', 'ZAR'],
    ['5USD5', 'en-US', 'USD'],
    ['$1$0', 'en-US', 'USD'],
    ['1 € 2 €', 'fr-FR', 'EUR'],
    ['$5 USD', 'en-US', 'USD'],
    ['$-$5.00', 'en-US', 'USD'],
  ])('%s in %s is refused, never joined', (text, locale, currency) => {
    try {
      read(text, locale, currency);
    } catch (error) {
      expect(error).toBeUltimateError('X_MONEY_INPUT_INVALID');
      return;
    }
    expect.unreachable(`${text} in ${locale} was read as one amount`);
  });

  test.each([
    ['$5', 'en-US', 'USD', 500],
    ['5 $', 'en-US', 'USD', 500],
    ['-$5.00', 'en-US', 'USD', -500],
    ['$-5.00', 'en-US', 'USD', -500],
    ['USD 5', 'en-US', 'USD', 500],
    ['-12,50 €', 'fr-FR', 'EUR', -1_250],
    ['€ -12,50', 'nl-NL', 'EUR', -1_250],
  ])('%s in %s: a mark at the edge still reads', (text, locale, currency, minor) => {
    expect(read(text, locale, currency)).toEqual({ minor, currency });
  });
});

describe('parseAmount · every formatMoney display reads back', () => {
  const locales = [
    'en-US',
    'de-DE',
    'fr-FR',
    'nl-NL',
    'de-CH',
    'en-IN',
    'ar-EG',
    'ja-JP',
    'pt-BR',
    'de-AT',
    'fr-CH',
    'mr-IN',
    'en-ZA',
    'da-DK',
    'he-IL',
    'fa-IR',
  ];
  const currencies = ['USD', 'EUR', 'JPY', 'BHD', 'CHF', 'INR', 'ZAR'];
  test.each(locales)('%s', (locale) => {
    for (const currency of currencies) {
      for (const display of ['symbol', 'code', 'narrowSymbol'] as const) {
        for (const accounting of [false, true]) {
          for (const minor of [123_456_789, -123_456_789, 5, -5]) {
            const money = fromMinor(minor, currency);
            const shown = formatMoney(money, locale, { display, accounting });
            expect({ shown, read: read(shown, locale, currency) }).toEqual({ shown, read: money });
          }
        }
      }
    }
  });
});
