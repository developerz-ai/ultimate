// Tier 0: per-request memoization over `memo-store.ts` — keyed off the ALS ctx, so it dies with
// the request, and bounded at `MEMO_MAX_BYTES` per ctx. Outside a request (worker boot, a script)
// the tier degrades to a no-op rather than throwing: memoization is never required for correctness.

import { dropStore, putEntry, removeEntry, storeFor } from './memo-store';
import type { CacheTag } from './tags';
import { tagsIntersect } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation } from './tiers';
import { assertTtl } from './tiers';
import { decodeCacheValue, encodeCacheValue } from './value-codec';

export { MEMO_MAX_BYTES } from './memo-store';

/** Escape hatch for `x dev`'s long-lived contexts; a normal request never calls this. */
export function clearMemo(): void {
  dropStore();
}

export function memoSize(): number {
  return storeFor(false)?.entries.size ?? 0;
}

/** Bytes the current ctx's memo holds, against `MEMO_MAX_BYTES`. 0 outside a ctx. */
export function memoBytes(): number {
  return storeFor(false)?.bytes ?? 0;
}

export function memoTier(): CacheTier {
  return {
    name: 'request-memo',

    get<T>(key: string): Promise<CacheEntry<T> | undefined> {
      const entry = storeFor(false)?.entries.get(key);
      // No TTL check: a request is shorter than any meaningful TTL. A `memoPerRequest` entry is
      // never under a tier key (its keys are namespaced), so `kind` is a type guard, not a branch.
      if (entry?.kind !== 'text') return Promise.resolve(undefined);
      const { v } = decodeCacheValue(entry.text) as { readonly v: T };
      return Promise.resolve({ value: v, tags: entry.tags });
    },

    /**
     * The lease is VALIDATED and then discarded, which is not a contradiction.
     *
     * This tier holds nothing past the request, so it stores no `expiresAt` — but it is still a
     * rung of one ladder, and `assertTtl` is the one place that says what `ttlMs` may be. Skipping
     * it made `ttlMs: 0` a value the memo accepted and every other tier refused: `cacheStack`
     * routes each rung through `bestEffort`, so the miswiring was swallowed as two tier failures
     * and the read still hit — out of the one tier that never should have taken it. Exactly the
     * "two tiers, two readings of `0`" the rule exists to close.
     *
     * Only a lease the caller SUPPLIED is checked: there is no default to fall back to, because a
     * memo entry that outlives its request is not a thing that can happen. `jitterFraction: 0` for
     * `memorySemanticCache`'s reason — spreading a lease is a herd defence for a SHARED
     * store, and this one dies with the request that made it.
     */
    async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      if (options?.ttlMs !== undefined) {
        assertTtl(key, options.ttlMs, 'request-memo', { jitterFraction: 0 });
      }
      const text = encodeCacheValue({ v: value }, { key, tier: 'request-memo' });
      const store = storeFor(true);
      if (store !== undefined) {
        putEntry(store, key, { kind: 'text', text, tags: options?.tags ?? [], bytes: 0 });
      }
    },

    del(key: string): Promise<void> {
      const store = storeFor(false);
      if (store !== undefined) removeEntry(store, key);
      return Promise.resolve();
    },

    invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const store = storeFor(false);
      if (store === undefined) {
        return Promise.resolve({ tier: 'request-memo', keys: [], skipped: 'no request context' });
      }
      const keys: string[] = [];
      for (const [key, entry] of store.entries) {
        if (entry.kind === 'text' && tagsIntersect(tags, entry.tags)) {
          removeEntry(store, key);
          keys.push(key);
        }
      }
      return Promise.resolve({ tier: 'request-memo', keys });
    },
  };
}
