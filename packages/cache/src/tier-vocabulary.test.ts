// The rungs are named ONCE. `app.config.ts` picks tiers by name and this package builds them by
// name, so a second spelling anywhere is a `cache.tiers` entry that selects nothing — which is
// exactly what shipped through 8.0.0 (issue #293): the config accepted `memo | lru | shared | isr |
// cdn` and the ladder ordered `request-memo | lru | redis | cdn`.

import { describe, expect, test } from 'bun:test';
import { CACHE_TIERS } from '@ultimat3/core';
import { cdnTier } from './cdn';
import { lruTier } from './lru';
import { memoTier } from './memo';
import { redisTier } from './redis';
import type { CacheTier, TierName } from './tiers';
import { sortTiers } from './tiers';

/** A tier that does nothing but answer to a name — `sortTiers` reads nothing else. */
const stub = (name: string): CacheTier => ({
  name: name as TierName,
  get: async () => undefined,
  set: async () => {},
  del: async () => {},
  invalidateTags: async () => ({ tier: name as TierName, keys: [] }),
});

describe('one vocabulary for the rungs', () => {
  test('the ladder orders by the array core declares, not by a copy of it', () => {
    // The ladder imports core's array — no alias of it here (`X_HELPER_COPY`), so there is no
    // second name for a re-typed literal to hide behind.
    expect([...CACHE_TIERS]).toEqual(['request-memo', 'lru', 'redis', 'cdn']);
  });

  test('every tier this package ships is a name app.config.ts can select', () => {
    // The two directions together are the whole invariant: a factory whose name is not in the
    // config vocabulary is a rung no app can ask for, and a config name no factory answers to is
    // a `cache.tiers` entry that selects nothing.
    const built = [memoTier(), lruTier(), redisTier(), cdnTier()];
    expect(built.map((tier) => tier.name).sort()).toEqual([...CACHE_TIERS].sort());
  });

  test('every name the config accepts has a place on the ladder', () => {
    for (const name of CACHE_TIERS) expect(CACHE_TIERS.indexOf(name)).toBeGreaterThanOrEqual(0);
  });

  test('a name the ladder does not know sorts AHEAD of the request memo, never last', () => {
    // Why an unknown name may never reach here from config, and it is the dangerous direction:
    // `sortTiers` places by `indexOf`, so `-1` is nearest the request. Measured before the fix,
    // with the four names 8.0.0's `cache.tiers` accepted: ['memo', 'isr', 'lru', 'cdn'].
    // Built as `CacheTier[]` first, and `stub` widens the name at its one boundary: `memo` and
    // `isr` are names the union no longer holds, which is the point — the type system refusing
    // them inline is correct, and this case exists to show what the SORT does if one ever arrives
    // from an untyped source.
    const unknowns: readonly CacheTier[] = [stub('lru'), stub('memo'), stub('isr'), stub('cdn')];
    const ordered = sortTiers(unknowns);
    // Compared as strings: `memo` and `isr` are not `TierName` any more, and having the comparison
    // itself refused is the vocabulary change working. What is asserted is the ORDER.
    const names: readonly string[] = ordered.map((tier) => tier.name);
    expect(names).toEqual(['memo', 'isr', 'lru', 'cdn']);
  });

  test('the three spellings 8.0.0 accepted are gone, and isr was never a tier at all', () => {
    // `isr` is a `RenderMode`, revalidated by a tag bust — there is no ISR store to build here.
    const names: readonly string[] = CACHE_TIERS;
    for (const dead of ['memo', 'shared', 'isr']) expect(names).not.toContain(dead);
  });
});
