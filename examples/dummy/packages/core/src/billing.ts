/**
 * Plan upgrade arithmetic, and the billing period it prorates against. Everything here is integer
 * minor units with an attached currency; nothing in this file formats, and nothing converts
 * between currencies.
 */

import { type BillingCurrency, isUpgrade, type PlanCode, priceOf, seatLimit } from '@postly/domain';
import { isNegative, type Money, multiply, subtract, zero } from '@ultimat3/money';
import { addMs, fromZoned, type Instant, type TimeZone, toZoned } from '@ultimat3/time';
import { NotAnUpgrade, SeatsExceeded } from './errors';

export type UpgradeQuoteInput = {
  readonly from: PlanCode;
  readonly to: PlanCode;
  readonly currency: BillingCurrency;
  /** Whole days left in the current billing period, at the moment of the upgrade. */
  readonly daysRemaining: number;
  /** Length of the billing period in days — 28..31, taken from the real period, not assumed. */
  readonly daysInCycle: number;
};

export type UpgradeQuote = {
  /** Unused value of the old plan, credited back. */
  readonly credit: Money;
  /** What the org is charged today. Never negative. */
  readonly charge: Money;
  /** What the next full period will cost. */
  readonly nextPeriod: Money;
  readonly seats: number;
};

/**
 * Pro-rate by the fraction of the period that remains. `multiply` rounds half-up on the minor
 * unit inside @ultimat3/money, so the result is always a whole cent and two calls with the same
 * input agree — a float would leave a fraction of a cent to lose in an audit.
 */
export const quoteUpgrade = (input: UpgradeQuoteInput): UpgradeQuote => {
  if (!isUpgrade(input.from, input.to)) {
    throw new NotAnUpgrade({ from: input.from, to: input.to });
  }

  const fraction = Math.max(0, Math.min(1, input.daysRemaining / input.daysInCycle));
  const credit = multiply(priceOf(input.from, input.currency), fraction);
  const owed = subtract(multiply(priceOf(input.to, input.currency), fraction), credit);

  return {
    credit,
    charge: isNegative(owed) ? zero(input.currency) : owed,
    nextPeriod: priceOf(input.to, input.currency),
    seats: seatLimit(input.to),
  };
};

/**
 * A billing period is one calendar month in the org's zone, and it ends at the last millisecond of
 * its last local day — not at the first of the next, so `daysRemaining` never borrows a day from
 * the following cycle. `periodOffset` walks whole periods: `-1` is the period before `at`.
 *
 * Built from local calendar fields and converted once, because a month is 28..31 days and a day is
 * 23, 24 or 25 hours — neither is a constant to multiply by.
 */
export const endOfBillingPeriod = (at: Instant, zone: TimeZone, periodOffset = 0): Instant => {
  const local = toZoned(at, zone);
  const nextPeriodStart = fromZoned(
    { year: local.year, month: local.month + periodOffset + 1, day: 1, hour: 0, minute: 0 },
    zone,
  );
  return addMs(nextPeriodStart, -1);
};

/** Called before an invite is written, not after — the seat limit is a plan promise, not advice. */
export const assertSeatsAvailable = (plan: PlanCode, currentMembers: number): void => {
  const limit = seatLimit(plan);
  if (currentMembers + 1 > limit) {
    throw new SeatsExceeded({ plan, limit, requested: currentMembers + 1 });
  }
};

export const seatsRemaining = (plan: PlanCode, currentMembers: number): number =>
  Math.max(0, seatLimit(plan) - currentMembers);
