/** unit — no DB, no I/O. Every assertion is in minor units; nothing here formats money. */

import { expect, test } from 'bun:test';
import { addMs, daysBetween, fromIso, toIso } from '@ultimat3/time';
import {
  assertSeatsAvailable,
  billingPeriodAt,
  endOfBillingPeriod,
  quoteUpgrade,
  seatsRemaining,
} from './billing';
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

test('the period ends with the calendar month that contains the instant', () => {
  const midJanuary = fromIso('2026-01-10T12:00:00Z');
  expect(toIso(endOfBillingPeriod(midJanuary, 'UTC'))).toBe('2026-01-31T23:59:59.999Z');
  expect(toIso(endOfBillingPeriod(midJanuary, 'UTC', -1))).toBe('2025-12-31T23:59:59.999Z');
});

test('month length is read from the calendar, never assumed to be 30', () => {
  const endOf = (iso: string): string => toIso(endOfBillingPeriod(fromIso(iso), 'UTC'));
  expect(endOf('2026-01-15T00:00:00Z')).toBe('2026-01-31T23:59:59.999Z'); // 31 days
  expect(endOf('2026-04-15T00:00:00Z')).toBe('2026-04-30T23:59:59.999Z'); // 30 days
  expect(endOf('2026-02-15T00:00:00Z')).toBe('2026-02-28T23:59:59.999Z'); // 28
  expect(endOf('2024-02-15T00:00:00Z')).toBe('2024-02-29T23:59:59.999Z'); // 29, leap
});

test('it lands on the last instant of the period, not the first of the next', () => {
  const end = endOfBillingPeriod(fromIso('2026-01-10T12:00:00Z'), 'UTC');
  expect(toIso(addMs(end, 1))).toBe('2026-02-01T00:00:00.000Z');
});

test('the period boundary is local: New York ends January five hours after UTC does', () => {
  const midJanuary = fromIso('2026-01-10T12:00:00Z');
  expect(toIso(endOfBillingPeriod(midJanuary, 'America/New_York'))).toBe(
    '2026-02-01T04:59:59.999Z',
  );
});

test('the cycle length a quote prorates against is the real month, DST included', () => {
  const cycleAt = (iso: string, zone: string): number => {
    const at = fromIso(iso);
    return daysBetween(endOfBillingPeriod(at, zone, -1), endOfBillingPeriod(at, zone), zone);
  };

  expect(cycleAt('2026-02-15T00:00:00Z', 'UTC')).toBe(28);
  expect(cycleAt('2026-01-15T00:00:00Z', 'UTC')).toBe(31);
  // March in New York contains a 23-hour day; it is still 31 days long.
  expect(cycleAt('2026-03-15T00:00:00Z', 'America/New_York')).toBe(31);
});

test('the period a quote prorates against is read off the calendar, never 15/30', () => {
  const period = (iso: string, zone: string) => billingPeriodAt(fromIso(iso), zone);

  expect(period('2026-02-15T00:00:00Z', 'UTC')).toEqual({ daysRemaining: 13, daysInCycle: 28 });
  expect(period('2026-01-15T00:00:00Z', 'UTC')).toEqual({ daysRemaining: 16, daysInCycle: 31 });
  // March in New York contains a 23-hour day; it is still 31 days long. And it is still 14 March
  // there when it is already the 15th in UTC, so the same instant has 17 days left rather than
  // 16 — local day boundaries, not elapsed milliseconds.
  expect(period('2026-03-15T00:00:00Z', 'America/New_York')).toEqual({
    daysRemaining: 17,
    daysInCycle: 31,
  });
  // Autumn-back: New York's November is 30 local days and 30 days PLUS an hour of real time, so
  // `differenceMs / 86_400_000` answers 30 days remaining on the 1st — one whole day of the
  // customer's money — where local day boundaries answer 29.
  expect(period('2026-11-01T04:00:00Z', 'America/New_York')).toEqual({
    daysRemaining: 29,
    daysInCycle: 30,
  });
});

test('the last local day of a period has nothing left to prorate', () => {
  expect(billingPeriodAt(fromIso('2026-01-31T23:00:00Z'), 'UTC').daysRemaining).toBe(0);
  // Same instant, five hours behind: it is still 31 January in New York, and also the last day.
  expect(billingPeriodAt(fromIso('2026-02-01T04:00:00Z'), 'America/New_York').daysRemaining).toBe(
    0,
  );
});

test('a quote built from the real period charges for the days that are actually left', () => {
  const { daysRemaining, daysInCycle } = billingPeriodAt(fromIso('2026-02-15T00:00:00Z'), 'UTC');
  const quote = quoteUpgrade({
    from: 'free',
    to: 'team',
    currency: 'USD',
    daysRemaining,
    daysInCycle,
  });

  // 13/28 of $19.00, rounded half-up on the minor unit — not the 15/30 that shipped.
  expect(quote.charge).toEqual({ minor: 882, currency: 'USD' });
});

test('an unusable zone is refused rather than silently answered in UTC', () => {
  expect(codeOf(() => billingPeriodAt(fromIso('2026-02-15T00:00:00Z'), 'Mars/Olympus'))).toBe(
    'X_TIMEZONE_INVALID',
  );
});
