// The catalog's prices reach structured data and payment providers as decimal strings, and
// nothing else in the app is allowed to do that conversion. A regression here is a JSON-LD offer
// quoting `1900` dollars for a $19 plan — valid markup, wrong number, indexed by everyone.

import { expect, test } from 'bun:test';
import { DEFAULT_BILLING_CURRENCY, priceDecimalOf, priceOf } from './plans';

test('a decimal price is minor units scaled, never the integer and never a float', () => {
  expect(priceDecimalOf('team', 'USD')).toBe('19.00');
  expect(priceDecimalOf('business', 'EUR')).toBe('74.00');
});

test('a free plan is priced, not omitted', () => {
  // `0` would be falsy at every call site that renders it; `'0.00'` is a price.
  expect(priceDecimalOf('free', 'USD')).toBe('0.00');
});

test('the decimal form is the catalog row, never a converted one', () => {
  // Postly prices per market. EUR is its own row, so the two never agree by arithmetic.
  expect(priceOf('team', 'EUR').minor).toBe(1800);
  expect(priceDecimalOf('team', 'EUR')).toBe('18.00');
});

test('the default currency is one the catalog prices every plan in', () => {
  for (const code of ['free', 'team', 'business'] as const) {
    expect(priceOf(code, DEFAULT_BILLING_CURRENCY).currency).toBe(DEFAULT_BILLING_CURRENCY);
  }
});
