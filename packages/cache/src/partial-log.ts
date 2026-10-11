// Single responsibility: how often `cache.invalidate.partial` is said. A tier that keeps refusing
// — the broadcast, while the bus is away — is ONE condition on a process that is still serving:
// a warning on its 1st, 2nd, 4th, 8th, … refusal and one line when it clears again, never one
// line per bust per publisher for as long as an outage lasts. The report itself is unchanged:
// every caller still gets every error, and the `/_x` panel still records every bust.

import { isOutageMilestone, logger } from '@ultimat3/core';

/** The line a partial bust writes; `<event> recovered` when a failing tier clears again. */
export const INVALIDATE_PARTIAL = 'cache.invalidate.partial';

/**
 * Tier names tracked at once. A name is a registered tier's, `isr` or `broadcast` — a handful —
 * so this is never reached by a real app; past it a refusal is simply said every time.
 */
const MAX_TRACKED_TIERS = 64;

/** Consecutive refusals per tier name, since that tier last cleared. */
const refusals = new Map<string, number>();

/**
 * One finished bust. `errors` is what it could not clear; `cleared` names every tier that was
 * ASKED and answered — a tier this bust never reached (a bust with nothing to broadcast) has
 * said nothing about its own outage, so it ends none.
 */
export function logPartial<R extends { readonly errors: readonly { readonly tier: string }[] }>(
  report: R,
  cleared: readonly string[],
): void {
  for (const tier of cleared) {
    const after = refusals.get(tier);
    if (after === undefined) continue;
    refusals.delete(tier);
    logger.info(`${INVALIDATE_PARTIAL} recovered`, { tier, after });
  }
  let said = false;
  let failures = 0;
  for (const tier of new Set(report.errors.map((error) => error.tier))) {
    if (!refusals.has(tier) && refusals.size >= MAX_TRACKED_TIERS) {
      said = true;
      continue;
    }
    const count = (refusals.get(tier) ?? 0) + 1;
    refusals.set(tier, count);
    failures = Math.max(failures, count);
    if (isOutageMilestone(count)) said = true;
  }
  if (said) logger.warn(INVALIDATE_PARTIAL, { ...report, failures });
}

/** Test seam, and `resetTiers()`'s: every tier starts unrefused. */
export function resetPartialLog(): void {
  refusals.clear();
}
