// Property: any amount `formatMoney` shows a person, `parseAmount` reads back to the same minor
// units — in every locale's separators, digits and grouping, and every currency's exponent.

import { describe, expect, test } from 'bun:test';
// Relative: `@ultimat3/testing` declares no `@ultimat3/money` dependency, and a test never ships.
import { formatMoney, parseAmount } from '../../money/src/index';
import { property } from './property';
import { gen } from './property-gen';

const LOCALES = [
  'en-US',
  'de-DE',
  'fr-FR',
  'de-CH',
  'en-IN',
  'ar-EG',
  'ja-JP',
  'hi-IN',
  'pt-BR',
] as const;
const CURRENCIES = ['USD', 'EUR', 'JPY', 'BHD', 'CHF', 'INR'] as const;

const roundTrips = (minor: number, currency: string, locale: string): void => {
  const read = parseAmount(formatMoney({ minor, currency }, locale), { currency, locale });
  expect({ minor: read.minor, currency: read.currency }).toEqual({ minor, currency });
};

const amount = gen.tuple(
  gen.int(-1_000_000_000_000, 1_000_000_000_000),
  gen.oneOf(CURRENCIES),
  gen.oneOf(LOCALES),
);

describe('money properties', () => {
  test('parseAmount(formatMoney(m, locale)) is m', () => {
    property(
      amount,
      ([minor, currency, locale]) => {
        roundTrips(minor, currency, locale);
      },
      { runs: 400 },
    );
  });

  // Found by the property above (sweep 15): `ar-EG` closes BHD's right-to-left symbol with U+200F,
  // and a parse that trimmed before stripping the mark refused the no-break space it shielded.
  test('BHD in ar-EG round-trips', () => {
    property(gen.int(-1_000_000, 1_000_000), (minor) => roundTrips(minor, 'BHD', 'ar-EG'));
  });
});
