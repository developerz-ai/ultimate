/** unit — no DB, no I/O. Every assertion is in minor units; nothing here formats money. */

import { expect, test } from 'bun:test';
import { assertSeatsAvailable, quoteUpgrade, seatsRemaining } from './billing';
import type { CoreError } from './errors';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as CoreError).code;
  }
};

test('free → team, half a cycle: nothing to credit, half the price to charge', () => {
  const quote = quoteUpgrade({
    from: 'free',
    to: 'team',
    currency: 'USD',
    daysRemaining: 15,
    daysInCycle: 30,
  });

  expect(quote.credit).toEqual({ minor: 0, currency: 'USD' });
  expect(quote.charge).toEqual({ minor: 950, currency: 'USD' });
  expect(quote.nextPeriod).toEqual({ minor: 1900, currency: 'USD' });
  expect(quote.seats).toBe(25);
});

test('EUR is priced independently — the quote is not a converted USD number', () => {
  const quote = quoteUpgrade({
    from: 'team',
    to: 'business',
    currency: 'EUR',
    daysRemaining: 15,
    daysInCycle: 30,
  });

  expect(quote.credit).toEqual({ minor: 900, currency: 'EUR' }); // half of EUR 18.00
  expect(quote.charge).toEqual({ minor: 2800, currency: 'EUR' }); // half of 74.00 minus credit
  expect(quote.nextPeriod.currency).toBe('EUR');
});

test('a partial day never produces a fraction of a cent', () => {
  const quote = quoteUpgrade({
    from: 'team',
    to: 'business',
    currency: 'USD',
    daysRemaining: 1,
    daysInCycle: 31,
  });

  expect(Number.isInteger(quote.charge.minor)).toBe(true);
  expect(Number.isInteger(quote.credit.minor)).toBe(true);
  expect(quote.charge.minor).toBeGreaterThan(0);
});

test('upgrading on the last day of a cycle charges nothing today', () => {
  const quote = quoteUpgrade({
    from: 'free',
    to: 'business',
    currency: 'USD',
    daysRemaining: 0,
    daysInCycle: 30,
  });

  expect(quote.charge).toEqual({ minor: 0, currency: 'USD' });
  expect(quote.nextPeriod).toEqual({ minor: 7900, currency: 'USD' });
});

test('a downgrade is refused, not quoted as a negative charge', () => {
  expect(
    codeOf(() =>
      quoteUpgrade({
        from: 'business',
        to: 'team',
        currency: 'USD',
        daysRemaining: 10,
        daysInCycle: 30,
      }),
    ),
  ).toBe('X_BILLING_NOT_AN_UPGRADE');
});

test('the seat limit is checked before the invite, and names the fix', () => {
  expect(seatsRemaining('free', 2)).toBe(1);
  expect(codeOf(() => assertSeatsAvailable('free', 2))).toBeUndefined();
  expect(codeOf(() => assertSeatsAvailable('free', 3))).toBe('X_BILLING_SEATS_EXCEEDED');
});
