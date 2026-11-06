/**
 * `planPrices`: the billing vendor's price feed, followed for ever. `consumer()` is a job factory,
 * not a ninth primitive — this is a job keyed per vendor account plus a `.supervisor` task that
 * re-arms it, and every rail a hand-rolled one forgets (one body per key, no timeout, the drain, a
 * cursor committed with its batch) is the factory's, not a line here.
 *
 * `consumer` comes from @ultimat3/jobs: a job file imports one package for it.
 */

import { consumer } from '@ultimat3/jobs';
import { cursorOf, saveCursor, upsertPlans } from '../repo';
import { priceFeed, pricesBehind, VENDOR_ACCOUNT, type VendorPrice } from '../vendor';

/** The durable name — the queue key, the idempotency key's prefix and the cursor rows' prefix. */
export const PLAN_PRICES = 'billing.plan-prices';

/** One cursor row per key, so two accounts never share a position. */
export const streamOf = (key: string): string => `${PLAN_PRICES}:${key}`;

/**
 * The cursor past a batch: its last item's `seq`. The feed is ordered, so the last is the highest,
 * and an empty batch never reaches here — `consumer()` hands `handle` at least one item.
 */
export const positionAfter = (items: readonly VendorPrice[]): number =>
  items.reduce((highest, item) => Math.max(highest, item.seq), 0);

export const planPrices = consumer<VendorPrice, number>({
  name: PLAN_PRICES,
  // The vendor's account is Postly's, and `plans` is the catalog every org reads: no tenant.
  tenant: 'none',
  keys: () => [VENDOR_ACCOUNT],
  open: ({ key, cursor, signal }) => priceFeed(key, cursor, signal),
  // At least once: a drained or failed batch is delivered again, so the write is an upsert on the
  // plan's own key — a replay lands on the row it already wrote, never a second one.
  handle: async ({ items }) => {
    await upsertPlans(items);
    return positionAfter(items);
  },
  // `save` runs in the SAME transaction as `handle`, so the prices and the position past them
  // commit together or not at all.
  cursor: {
    load: (key) => cursorOf(streamOf(key)),
    save: (key, next) => saveCursor(streamOf(key), next),
  },
  lag: ({ key, cursor }) => pricesBehind(key, cursor),
  // Defaults left in place here:
  // batch: 100,  // items per transaction
  // rearm: '1m', // how often the supervisor re-arms every key
});
