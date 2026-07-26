/**
 * The plan catalog. Prices are integer minor units with a currency, one row per currency —
 * Postly never converts money at runtime, because an FX rate is not a product decision.
 */

import type { Money } from '@ultimat3/money';
import { InvariantViolation } from './errors';

export const PLAN_CODES = ['free', 'team', 'business'] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_CURRENCIES = ['USD', 'EUR'] as const;

export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];

export type Plan = {
  readonly code: PlanCode;
  readonly seats: number;
  /** Monthly price per supported currency. Minor units: 1900 USD = $19.00. */
  readonly monthly: Readonly<Record<BillingCurrency, Money>>;
};

export const PLAN_CATALOG: Readonly<Record<PlanCode, Plan>> = Object.freeze({
  free: {
    code: 'free',
    seats: 3,
    monthly: { USD: { minor: 0, currency: 'USD' }, EUR: { minor: 0, currency: 'EUR' } },
  },
  team: {
    code: 'team',
    seats: 25,
    monthly: { USD: { minor: 1900, currency: 'USD' }, EUR: { minor: 1800, currency: 'EUR' } },
  },
  business: {
    code: 'business',
    seats: 200,
    monthly: { USD: { minor: 7900, currency: 'USD' }, EUR: { minor: 7400, currency: 'EUR' } },
  },
});

export const PLAN_ORDER: Readonly<Record<PlanCode, number>> = Object.freeze({
  free: 0,
  team: 1,
  business: 2,
});

export const seatLimit = (code: PlanCode): number => PLAN_CATALOG[code].seats;

export const priceOf = (code: PlanCode, currency: BillingCurrency): Money =>
  PLAN_CATALOG[code].monthly[currency];

export const isUpgrade = (from: PlanCode, to: PlanCode): boolean =>
  PLAN_ORDER[to] > PLAN_ORDER[from];

export const assertBillingCurrency = (value: string): BillingCurrency => {
  const currency = BILLING_CURRENCIES.find((candidate) => candidate === value);
  if (!currency) {
    throw new InvariantViolation({
      invariant: 'plan.currency',
      cause: `currency ${JSON.stringify(value)} is not billable; supported: ${BILLING_CURRENCIES.join(', ')}`,
      fix: 'add the currency to BILLING_CURRENCIES and price every plan in it',
    });
  }
  return currency;
};
