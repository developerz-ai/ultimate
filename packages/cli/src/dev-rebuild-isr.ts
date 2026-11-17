// What `x dev`'s rebuild does to the ISR store on a save: every stored page goes, so the next
// request renders with the new module.

import { markAllInvalidated } from '@ultimat3/cache';
import type { IsrStore } from '@ultimat3/render/server';

/**
 * Empty the store a save made stale — after voiding every fill in flight. A render that began with
 * the OLD module before the save samples its fence first; deleted paths alone left that fence
 * valid, so the pre-save HTML landed after the clear as a fresh page (audit round 2). Never
 * `flushProcessTiers`: that also purges a CDN tier, the real CDN when its keys are in `.env`.
 */
export async function clearIsrForRebuild(store: IsrStore): Promise<void> {
  markAllInvalidated();
  // Awaited one by one: a shared store answers over the network, and a dev save is rare.
  for (const path of await store.paths()) await store.delete(path);
}
