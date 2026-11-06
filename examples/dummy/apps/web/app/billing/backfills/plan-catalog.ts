/**
 * `planCatalog`: one pass importing the billing vendor's whole catalog, page by page. `pages` is
 * `backfill()`'s remote source — beside `source`, never both — so a pass killed mid-catalog asks
 * the vendor for THAT page again and no earlier one: only `{ cursor, rows }` is checkpointed.
 *
 * The import is the one-off; `planPrices` (`../jobs/plan-prices.ts`) follows the changes after it.
 */

import { backfill } from '@ultimat3/jobs';
import { upsertPlans } from '../repo';
import { catalogPage, type VendorPrice } from '../vendor';

export const planCatalog = backfill<VendorPrice>({
  name: 'billing.plan-catalog',
  // The catalog belongs to no org, so the pass runs under none.
  tenant: 'none',
  pages: ({ cursor, signal }) => catalogPage(cursor, signal),
  // At least once, like every job body: a page replays whole after a cancel between its last row
  // and its checkpoint, so the write is an upsert on the plan's own key.
  handle: async ({ rows, signal }) => {
    signal.throwIfAborted();
    await upsertPlans(rows);
  },
  // No `count`: a remote may not know how much is left, and then the stall check is silent.
});
