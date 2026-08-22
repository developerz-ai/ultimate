// The stampede guard's own suite: what a joiner that shares an in-flight `load()` contributes to
// the write it also shares. Kept apart from `tiers.test.ts` because the ladder's order, expiry and
// write-back are answerable from one caller, and every question here needs two — a leader and a
// joiner interleaved at a named await.

import { describe, expect, test } from 'bun:test';
import { tag } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack } from './tiers';

/**
 * A tier that keeps the tags it was written with and evicts on them. `tiers.test.ts`'s `fakeTier`
 * answers `invalidateTags` with an empty key list, which is exactly the half this suite observes,
 * so the fixture is this file's own rather than a shared one widened for one caller.
 */
function taggingTier(name: CacheTier['name']): CacheTier & {
  readonly entries: Map<string, CacheEntry<unknown>>;
  onSet?: ((key: string, options?: CacheSetOptions) => Promise<void>) | undefined;
} {
  const entries = new Map<string, CacheEntry<unknown>>();
  const tier = {
    name,
    entries,
    onSet: undefined as ((key: string, options?: CacheSetOptions) => Promise<void>) | undefined,
    get<T>(key: string) {
      return Promise.resolve(entries.get(key) as CacheEntry<T> | undefined);
    },
    async set<T>(key: string, value: T, options?: CacheSetOptions) {
      await tier.onSet?.(key, options);
      entries.set(key, { value, tags: options?.tags ?? [] });
    },
    del(key: string) {
      entries.delete(key);
      return Promise.resolve();
    },
    invalidateTags(tags: readonly ReturnType<typeof tag>[]) {
      const wanted = new Set(
        tags.map((t) => (t.id === undefined ? t.entity : `${t.entity}:${t.id}`)),
      );
      const keys: string[] = [];
      for (const [key, entry] of entries) {
        const hit = entry.tags.some((t) =>
          wanted.has(t.id === undefined ? t.entity : `${t.entity}:${t.id}`),
        );
        if (!hit) continue;
        keys.push(key);
        entries.delete(key);
      }
      return Promise.resolve({ tier: name, keys });
    },
  };
  return tier;
}

describe('a single-flight joiner that arrives during the FILL', () => {
  test('gets its tag onto the entry that lands, on every tier', async () => {
    // The leader reads the merged context ONCE, before the ladder it then walks one await per
    // rung — so a joiner that merges `feed` while the fill is in flight shares the leader's
    // value, shares the leader's write, and the entry lands under the leader's tags alone.
    // `invalidateTags(['feed'])` then never reaches it, and the joiner's own invalidation — the
    // entire reason for declaring a tag — is silently a no-op for the whole TTL.
    const tier = taggingTier('lru');
    const stack = createCacheStack([tier]);
    const writes: string[][] = [];
    let joiner: Promise<string> | undefined;

    tier.onSet = async (key, options) => {
      writes.push((options?.tags ?? []).map((t) => t.entity));
      if (joiner !== undefined) return;
      joiner = stack.read(key, () => Promise.resolve('joined'), { tags: [tag('feed')] });
      // A macrotask: the joiner's own lookup is a chain of microtasks, so yielding here lands
      // after it has reached `flight.run` and merged — and before this write completes.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    };

    const leader = await stack.read('k', () => Promise.resolve('led'), { tags: [tag('post')] });
    expect(leader).toBe('led');
    expect(await joiner).toBe('led');

    expect(
      tier.entries
        .get('k')
        ?.tags.map((t) => t.entity)
        .sort(),
    ).toEqual(['feed', 'post']);
    expect(writes[0]).toEqual(['post']);

    const invalidated = await tier.invalidateTags([tag('feed')]);
    expect(invalidated.keys).toEqual(['k']);
    expect(await tier.get('k')).toBeUndefined();
  });
});
