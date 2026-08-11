/**
 * The billing catalog: one row per (plan, currency). A `money()` column is an integer
 * minor-unit amount plus its ISO currency — never a float, never a single "price in cents"
 * column whose currency lives in a comment.
 */

import { BILLING_CURRENCIES, PLAN_CODES } from '@postly/domain';
import { entity, enumerated, integer, invariant, money } from '@ultimat3/entity';

export const plans = entity('plans', {
  columns: {
    code: enumerated(PLAN_CODES),
    currency: enumerated(BILLING_CURRENCIES),
    /** Emits `monthly_minor bigint` + `monthly_currency char(3)` with a matching CHECK. */
    monthly: money(),
    seats: integer(),
  },
  primaryKey: ['code', 'currency'],
  invariants: (c) => [
    invariant('plan_price_non_negative', c.monthly.minor.atLeast(0)),
    /** The row's own currency and its price's currency cannot drift apart. */
    invariant('plan_currency_matches_price', c.monthly.currency.eq(c.currency)),
    invariant('plan_seats_positive', c.seats.atLeast(1)),
  ],
});

export type PlanRow = typeof plans.$row;
