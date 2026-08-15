// The landing page and `/pricing` both price public pages, and `meta` reads a URL while the body
// reads a parsed query. One rule behind both, or the JSON-LD a crawler indexes quotes a currency
// the visitor was never shown.

import { expect, unitTest } from '@ultimat3/testing';
import { currencyFromUrl, currencyOf } from './currency';

unitTest('a billable currency is taken as written', () => {
  expect(currencyOf('EUR')).toBe('EUR');
  expect(currencyOf('USD')).toBe('USD');
});

unitTest('anything Postly does not price in falls back rather than throwing', () => {
  // A bad `?currency=` is a stale link, not a 500 — and never a page that prices in a currency
  // no plan has a row for.
  expect(currencyOf('GBP')).toBe('USD');
  expect(currencyOf('')).toBe('USD');
  expect(currencyOf(undefined)).toBe('USD');
});

unitTest('the URL form reads the same parameter the page body does', () => {
  expect(currencyFromUrl('https://postly.dev/pricing?currency=EUR')).toBe('EUR');
  expect(currencyFromUrl('https://postly.dev/pricing')).toBe('USD');
  expect(currencyFromUrl('https://postly.dev/pricing?currency=JPY')).toBe('USD');
});

unitTest('a currency on any page resolves, not only on /pricing', () => {
  // The landing page's JSON-LD offer is priced by the same rule, so a link carrying a currency
  // into `/` declares that currency instead of silently declaring dollars.
  expect(currencyFromUrl('https://postly.dev/?currency=EUR')).toBe('EUR');
});
