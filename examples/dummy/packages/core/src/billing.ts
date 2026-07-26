/**
 * Plan upgrade arithmetic. Everything here is integer minor units with an attached currency;
 * nothing in this file formats, and nothing converts between currencies.
 */

import { type BillingCurrency, isUpgrade, type PlanCode, priceOf, seatLimit } from '@postly/domain';
import { isNegative, type Money, multiply, subtract, zero } from '@ultimat3/money';
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

/** Called before an invite is written, not after — the seat limit is a plan promise, not advice. */
export const assertSeatsAvailable = (plan: PlanCode, currentMembers: number): void => {
  const limit = seatLimit(plan);
  if (currentMembers + 1 > limit) {
    throw new SeatsExceeded({ plan, limit, requested: currentMembers + 1 });
  }
};

export const seatsRemaining = (plan: PlanCode, currentMembers: number): number =>
  Math.max(0, seatLimit(plan) - currentMembers);
