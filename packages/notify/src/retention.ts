// The two sweeps over this package's tables, read off the installed seam rather than off a store
// somebody handed the caller. `setNotifyStores` is an APP's boot line and runs after the boot that
// owns the hourly sweep, so the sweep cannot hold the stores — it can only ask, per attempt, what
// is installed now. Same shape and the same reason as `purgeAuthLimits()`.

import type { InboxPurgeBefore, PgInboxStore } from './inbox-pg';
import type { PgDeliveryLedger } from './ledger-pg';
import { notifyStores } from './stores';

/**
 * Whether the installed store can delete by age at all.
 *
 * A DECLARED capability check, never duck typing: `PgInboxStore` and `PgDeliveryLedger` widen the
 * seam their memory siblings satisfy, so "has this method" is exactly "is this the Postgres one".
 * The memory stores deliberately have none — a heap map is bounded by process life, and adding the
 * method to `InboxStore`/`DeliveryLedger` would break every app that wrote its own implementation.
 */
const purgeable = <T>(store: unknown, method: string): store is T =>
  typeof store === 'object' &&
  store !== null &&
  typeof (store as Record<string, unknown>)[method] === 'function';

/**
 * Delete inbox rows past whichever windows the app named, and answer how many.
 *
 * ZERO IS THE ANSWER FOR "nothing to do", and there are three ways to reach it — no inbox
 * installed, a memory inbox, or both windows unset. None of them is an error: an app that never
 * configured retention has made a decision, and a sweep that threw would take the other framework
 * tables' sweep down with it.
 */
export async function purgeNotifyInbox(before: InboxPurgeBefore): Promise<number> {
  const store = notifyStores().inbox;
  if (!purgeable<PgInboxStore>(store, 'purgeBefore')) return 0;
  return store.purgeBefore(before);
}

/**
 * Delete delivery claims past the ledger's own window, and answer how many. The window is the
 * LEDGER's, never this caller's: `createPgDeliveryLedger({ windowMs })` is where an app states it,
 * beside the statement that reads it, so there is one number rather than two that can disagree.
 *
 * `nowMs` is the job's clock for the reason `x_rate_limit`'s target states — `at` is written by
 * whichever process took the delivery, so a cutoff computed inside Postgres measures the offset
 * between two clocks rather than the age of the row.
 */
export async function purgeNotifyDeliveries(nowMs: number): Promise<number> {
  const ledger = notifyStores().ledger;
  if (!purgeable<PgDeliveryLedger>(ledger, 'purgeExpired')) return 0;
  return ledger.purgeExpired(nowMs);
}
