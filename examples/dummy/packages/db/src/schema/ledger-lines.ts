/**
 * The org's money book: one row per leg of a double-entry posting, which `postCharge`
 * (`apps/web/app/billing/jobs/post-charge.ts`) writes through `@ultimat3/jobs`' `ledger()`. The
 * accounts are Postly's own words; the framework only checks that each posting nets to zero.
 */

import { entity, integer, money, text, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';

export const ledgerLines = entity('ledger_lines', {
  columns: {
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    /** The posting's identity — the vendor's charge id — and so the replay key, per org. */
    postingKey: text({ max: 120 }),
    line: integer(),
    account: text({ max: 60 }),
    amount: money(),
  },
  // One posting per (org, key): a replayed charge lands on the lines it already wrote.
  primaryKey: ['orgId', 'postingKey', 'line'],
});

export type LedgerLine = typeof ledgerLines.$row;
