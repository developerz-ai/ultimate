// Tier 0: per-request memoization. Keyed off the ALS context object itself via a WeakMap,
// so the store dies with the request — there is no `clear()` to forget, no cross-request
// leak, and no lifecycle for an agent to get wrong. Outside a request (worker boot, a
// script) the tier degrades to a no-op rather than throwing: memoization is never required
// for correctness.

import type { Ctx } from '@ultimat3/core';
import { useContext } from '@ultimat3/core';
import type { CacheTag } from './tags';
import { tagsIntersect } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation } from './tiers';
import { assertTtl } from './tiers';

type MemoStore = Map<string, CacheEntry<unknown>>;

const stores = new WeakMap<object, MemoStore>();

function currentCtx(): object | undefined {
  try {
    const ctx: Ctx = useContext();
    return typeof ctx === 'object' && ctx !== null ? (ctx as object) : undefined;
  } catch {
    // No ambient context: not a request. Nothing to memoize against.
    return undefined;
  }
}

function storeFor(create: boolean): MemoStore | undefined {
  const ctx = currentCtx();
  if (ctx === undefined) return undefined;
  const existing = stores.get(ctx);
  if (existing !== undefined) return existing;
  if (!create) return undefined;
  const fresh: MemoStore = new Map();
  stores.set(ctx, fresh);
  return fresh;
}

/** Escape hatch for `x dev`'s long-lived contexts; a normal request never calls this. */
export function clearMemo(): void {
  const ctx = currentCtx();
  if (ctx !== undefined) stores.delete(ctx);
}

export function memoSize(): number {
  return storeFor(false)?.size ?? 0;
}

export function createMemoTier(): CacheTier {
  return {
    name: 'request-memo',

    get<T>(key: string): Promise<CacheEntry<T> | undefined> {
      const entry = storeFor(false)?.get(key);
      // No TTL check: a request is shorter than any meaningful TTL.
      return Promise.resolve(entry as CacheEntry<T> | undefined);
    },

    /**
     * The lease is VALIDATED and then discarded, which is not a contradiction.
     *
     * This tier holds nothing past the request, so it stores no `expiresAt` — but it is still a
     * rung of one ladder, and `assertTtl` is the one place that says what `ttlMs` may be. Skipping
     * it made `ttlMs: 0` a value the memo accepted and every other tier refused: `createCacheStack`
     * routes each rung through `bestEffort`, so the miswiring was swallowed as two tier failures
     * and the read still hit — out of the one tier that never should have taken it. Exactly the
     * "two tiers, two readings of `0`" the rule exists to close.
     *
     * Only a lease the caller SUPPLIED is checked: there is no default to fall back to, because a
     * memo entry that outlives its request is not a thing that can happen. `jitterFraction: 0` for
     * `createMemorySemanticCache`'s reason — spreading a lease is a herd defence for a SHARED
     * store, and this one dies with the request that made it.
     */
    async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      if (options?.ttlMs !== undefined) {
        assertTtl(key, options.ttlMs, 'request-memo', { jitterFraction: 0 });
      }
      storeFor(true)?.set(key, { value, tags: options?.tags ?? [] });
    },

    del(key: string): Promise<void> {
      storeFor(false)?.delete(key);
      return Promise.resolve();
    },

    invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const store = storeFor(false);
      if (store === undefined) {
        return Promise.resolve({ tier: 'request-memo', keys: [], skipped: 'no request context' });
      }
      const keys: string[] = [];
      for (const [key, entry] of store) {
        if (tagsIntersect(tags, entry.tags)) {
          store.delete(key);
          keys.push(key);
        }
      }
      return Promise.resolve({ tier: 'request-memo', keys });
    },
  };
}
