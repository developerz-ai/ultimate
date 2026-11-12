// Single responsibility: the boot screen for `cache.tiers` — every entry a rung the ladder can
// build, and at least one. Split from `config.ts` so the validator stays under its line ceiling.

import { CACHE_TIERS } from './cache-vocabulary';
import { renderCauseValue } from './error-render';

/**
 * A rung the ladder cannot build is the defect this key had: `sortTiers` places a name by its
 * index in `CACHE_TIERS`, and a name missing from it sorts to `-1` — AHEAD of the request memo.
 * So an unknown tier is refused at boot rather than silently ignored or silently placed first.
 * An EMPTY ladder is refused with the unknown rung: it builds no tier at all, so every read
 * misses and nothing says the cache was configured away.
 *
 * `renderCauseValue`, never `${tier}`: an untyped config file can say a Symbol or a null-prototype
 * object here, and interpolating either throws a bare `TypeError` where the coded refusal belongs.
 *
 * Answers whether a tier NAME failed, so the caller appends the rename remedy only then.
 */
export function cacheTierIssues(tiers: readonly unknown[], issues: string[]): boolean {
  if (tiers.length === 0) issues.push('cache.tiers must list at least one tier');
  let unknownTier = false;
  for (const tier of tiers) {
    if ((CACHE_TIERS as readonly unknown[]).includes(tier)) continue;
    issues.push(
      `cache.tiers contains ${renderCauseValue(tier)}, which is not one of ${CACHE_TIERS.join(', ')}`,
    );
    unknownTier = true;
  }
  return unknownTier;
}
