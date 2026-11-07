// Money arithmetic in minor units, and the currency mismatch that must throw rather than round.
// A float here is a rounding error nobody sees until it is on an invoice.
import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { add, DocsSiteCurrencyMismatchError, zero } from './index';

unitTest('money adds in minor units', () => {
  expect(add({ minor: 1050, currency: 'USD' }, { minor: 250, currency: 'USD' })).toEqual({
    minor: 1300,
    currency: 'USD',
  });
});

unitTest('money refuses to add across currencies, with a code and a fix', () => {
  expect(() => add(zero('USD'), zero('EUR'))).toThrow(DocsSiteCurrencyMismatchError);
  try {
    add(zero('USD'), zero('EUR'));
  } catch (error) {
    expect(error).toBeUltimateError('X_DOCS_SITE_CURRENCY_MISMATCH');
  }
});
