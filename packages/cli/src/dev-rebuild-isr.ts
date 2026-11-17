// What `x dev`'s rebuild does to the ISR store on a save: every stored page goes, so the next
// request renders with the new module.

import { markAllInvalidated } from '@ultimat3/cache';
import type { IsrController } from '@ultimat3/render/server';

/**
 * Forget every page a save made stale — after voiding every fill in flight. A render that began
 * with the OLD module before the save samples its fence first; deleted paths alone left that fence
 * valid (audit round 2), and a request after the save still JOINED that render's flight (round 3):
 * `forgetAll` evicts the flights too. Never `flushProcessTiers`: that also purges a CDN tier, the
 * real CDN when its keys are in `.env`.
 */
export async function clearIsrForRebuild(isr: Pick<IsrController, 'forgetAll'>): Promise<void> {
  markAllInvalidated();
  await isr.forgetAll();
}
