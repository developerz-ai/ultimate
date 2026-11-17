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
  // A currency format that is not the plain-number one: de-AT groups a price with `.`, fr-CH marks
  // its decimal with `.`, mr-IN groups a price the Western way — each refused until 31.39.
  'de-AT',
  'fr-CH',
  'mr-IN',
  'en-ZA',
] as const;
// en-ZA's `ZAR 1 234,56` holds its symbol `R` inside its code; `narrowSymbol` and the accounting
// parentheses are what a price may also show, so each must read back.
const DISPLAYS = ['symbol', 'code', 'narrowSymbol'] as const;
type Display = (typeof DISPLAYS)[number];
const CURRENCIES = ['USD', 'EUR', 'JPY', 'BHD', 'CHF', 'INR'] as const;

const roundTrips = (
  minor: number,
  currency: string,
  locale: string,
  display: Display = 'symbol',
  accounting = false,
): void => {
  const shown = formatMoney({ minor, currency }, locale, { display, accounting });
  const read = parseAmount(shown, { currency, locale });
  expect({ minor: read.minor, currency: read.currency }).toEqual({ minor, currency });
};

const amount = gen.tuple(
  gen.int(-1_000_000_000_000, 1_000_000_000_000),
  gen.oneOf(CURRENCIES),
  gen.oneOf(LOCALES),
  gen.oneOf(DISPLAYS),
  gen.oneOf([false, true] as const),
);

describe('money properties', () => {
  test('parseAmount(formatMoney(m, locale)) is m', () => {
    property(
      amount,
      ([minor, currency, locale, display, accounting]) => {
        roundTrips(minor, currency, locale, display, accounting);
      },
      { runs: 400 },
    );
  });

  // Found by the property above (sweep 15): `ar-EG` closes BHD's right-to-left symbol with U+200F,
  // and a parse that trimmed before stripping the mark refused the no-break space it shielded.
  test('BHD in ar-EG round-trips', () => {
    property(gen.int(-1_000_000, 1_000_000), (minor) => roundTrips(minor, 'BHD', 'ar-EG'));
  });

  test('ZAR in en-ZA with the code displayed round-trips', () => {
    property(gen.int(-1_000_000, 1_000_000), (minor) => roundTrips(minor, 'ZAR', 'en-ZA', 'code'));
  });
});
