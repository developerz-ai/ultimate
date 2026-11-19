// Which shared tiers a cross-instance broadcast names as already cleared, and which of them a
// receiver may therefore skip. Kept apart from the fan-out so the skip rule has one home.

import type { CacheTier } from './tiers';

/**
 * Shared tier name → the `CacheTier.scope` a bust cleared there. A broadcast carries the sender's,
 * so a receiver skips only the shared tiers whose keys the sender's own bust already reached: on a
 * rolling deploy the two builds' Redis namespaces differ, and each must still be busted.
 */
export type SharedTierScopes = Readonly<Record<string, string>>;

/** What this process's bust clears in each shared tier — the `sender` its broadcast carries. */
export function sharedScopes(tiers: readonly CacheTier[]): SharedTierScopes {
  const scopes: Record<string, string> = {};
  for (const tier of tiers) {
    if (tier.fence !== undefined && tier.scope !== undefined) scopes[tier.name] = tier.scope;
  }
  return scopes;
}

/**
 * Inbound, a SHARED read tier is skipped only when the sender's bust reached the very keys this
 * one holds: same tier, same `scope`. A second bust per replica deleted what readers refilled
 * since and re-fenced their fills. Any doubt clears it — a frame naming no scope (an older pod),
 * another build's namespace on a rolling deploy, a fenced tier with no `scope` — because a skipped
 * bust is a pre-write row for the whole TTL, and a needless one is one more load.
 */
export function clearedBySender(tier: CacheTier, sender: SharedTierScopes | undefined): boolean {
  if (tier.fence === undefined || tier.scope === undefined || sender === undefined) return false;
  return Object.hasOwn(sender, tier.name) && sender[tier.name] === tier.scope;
}
