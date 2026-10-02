// The fence a SHARED tier keeps in its own store, and how a fill consults it. `fence.ts` answers
// for this process; a tier that other processes also write (`redis.ts`) answers for the fleet.
// Optional on `CacheTier`: an in-process tier has no second writer to be fenced against.

import type { FenceScope } from './fence';
import { bestEffort } from './tier-failures';
import type { CacheTier } from './tiers';

/**
 * `busted` is a PROOF the value is stale, so the whole fill is withdrawn — the near tiers too.
 * `unprovable` is the absence of one: that tier alone is left unwritten, because a shared store
 * that cannot vouch for a value must not take a process-local cache down with it.
 */
export type FenceVerdict = 'valid' | 'busted' | 'unprovable';

export interface TierFence {
  /** Asked AFTER the tier's own `set`, never before: see `bumpGenerations` for why. */
  verdict(): Promise<FenceVerdict>;
  /** Widen what the fence covers. A tag it never sampled makes it `unprovable`, not valid. */
  cover(scope: FenceScope): void;
}

const UNPROVABLE: TierFence = {
  verdict: () => Promise.resolve('unprovable'),
  cover: () => undefined,
};

export type TierFences = ReadonlyMap<CacheTier, TierFence>;

/** One sample per fenced tier, taken before `load()`. A tier that could not answer is unprovable. */
export async function sampleTierFences(
  tiers: readonly CacheTier[],
  key: string,
  scope: FenceScope,
): Promise<TierFences> {
  const fences = new Map<CacheTier, TierFence>();
  await Promise.all(
    tiers.map(async (tier) => {
      if (tier.fence === undefined) return;
      const sample = tier.fence.bind(tier);
      const fence = await bestEffort(tier.name, 'get', key, () => sample(scope));
      fences.set(tier, fence ?? UNPROVABLE);
    }),
  );
  return fences;
}

/** `unprovable` when the tier could not be asked — a refusal is never read as a clean bill. */
export async function verdictOf(
  tier: CacheTier,
  key: string,
  fences: TierFences | undefined,
): Promise<FenceVerdict> {
  const fence = fences?.get(tier);
  if (fence === undefined) return 'valid';
  return (await bestEffort(tier.name, 'get', key, () => fence.verdict())) ?? 'unprovable';
}
