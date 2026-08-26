/**
 * The tenant. Every other table hangs off an org, and every query is scoped by it —
 * multi-tenancy is a column, declared once, not a filter someone remembers to add.
 */

import { BILLING_CURRENCIES, PLAN_CODES, SLUG_MAX, SLUG_PATTERN } from '@postly/domain';
import { entity, enumerated, invariant, text, timestamp, uuid } from '@ultimat3/entity';

export const orgs = entity('orgs', {
  columns: {
    id: uuid().primaryKey(),
    /** Globally unique: it is the org's public URL segment. */
    slug: text({ max: SLUG_MAX }).unique(),
    name: text({ max: 80 }),
    planCode: enumerated(PLAN_CODES).default('free'),
    /** Chosen at signup, never converted afterwards. Prices exist per currency. */
    billingCurrency: enumerated(BILLING_CURRENCIES).default('USD'),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: (c) => [
    invariant('org_slug_shape', c.slug.matches(SLUG_PATTERN)),
    invariant('org_name_present', c.name.trimmed().minLength(1)),
  ],
  indexes: [{ on: ['planCode'] }],
});

export type Org = typeof orgs.$row;
