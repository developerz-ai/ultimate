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

    set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
      storeFor(true)?.set(key, { value, tags: options?.tags ?? [] });
      return Promise.resolve();
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
