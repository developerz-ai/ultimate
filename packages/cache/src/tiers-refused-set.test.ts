// A tier that REFUSES a `set` must not keep answering with what the set was replacing. The stack
// swallows the refusal (a tier may never fail a business write), so without a `del` the previous
// value serves from that tier for its whole lease — the one stale read that reports `errors: []`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createLruTier } from './lru';
import { isolateTierFailures, recentTierFailures, resetTierFailures } from './tier-failures';
import type { CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack } from './tiers';

// The failure log is the subject of one test below, so it is emptied per test and handed back.
const restoreFailures = isolateTierFailures();
afterAll(restoreFailures);
beforeEach(resetTierFailures);

/** A far tier that takes everything, so the near tier's refusal is the only thing in question. */
function mapTier(name: CacheTier['name']): CacheTier & { readonly held: Map<string, unknown> } {
  const held = new Map<string, unknown>();
  return {
    name,
    held,
    get: <T>(key: string) =>
      Promise.resolve(held.has(key) ? { value: held.get(key) as T, tags: [] } : undefined),
    set: <T>(key: string, value: T, _options?: CacheSetOptions) => {
      held.set(key, value);
      return Promise.resolve();
    },
    del: (key: string) => {
      held.delete(key);
      return Promise.resolve();
    },
    invalidateTags: () => Promise.resolve({ tier: name, keys: [] }),
  };
}

describe('a refused set in a fill deletes the key in THAT tier', () => {
  test('an overwrite the LRU refuses as too large does not leave the old value behind', async () => {
    const lru = createLruTier({ maxBytes: 100, rng: () => 0 });
    const stack = createCacheStack([lru]);
    await stack.write('k', 'old');

    await stack.write('k', 'x'.repeat(500));

    expect(lru.cache.get('k')).toBeUndefined();
  });

  test('read() then sees the value a further tier took, not the one the near tier kept', async () => {
    const lru = createLruTier({ maxBytes: 100, rng: () => 0 });
    const redis = mapTier('redis');
    const stack = createCacheStack([lru, redis]);
    await stack.write('k', 'old');
    const big = 'x'.repeat(500);

    await stack.write('k', big);

    expect(await stack.read('k', () => Promise.resolve('loaded'))).toBe(big);
    expect(redis.held.get('k')).toBe(big);
  });

  test('a refused lease is the same: the entry it would have replaced is gone', async () => {
    // The neighbour of the size refusal. `X_CACHE_TTL_INVALID` leaves a direct `LruCache.set`
    // caller's entry alone on purpose; in a FILL the caller's new value supersedes it either way.
    const lru = createLruTier({ maxBytes: 10_000, rng: () => 0 });
    const stack = createCacheStack([lru]);
    await stack.write('k', 'old');

    await stack.write('k', 'new', { ttlMs: 0 });

    expect(lru.cache.get('k')).toBeUndefined();
  });

  test('the refusal is still recorded, and the del is not reported as a second failure', async () => {
    const lru = createLruTier({ maxBytes: 100, rng: () => 0 });
    const stack = createCacheStack([lru]);
    await stack.write('k', 'old');
    await stack.write('k', 'x'.repeat(500));

    expect(recentTierFailures().map((failure) => `${failure.op}:${failure.code ?? ''}`)).toEqual([
      'set:X_CACHE_TOO_LARGE',
    ]);
  });

  test('a set that SUCCEEDS is never followed by a del', async () => {
    const calls: string[] = [];
    const tier = mapTier('lru');
    const spied: CacheTier = {
      ...tier,
      del: (key) => {
        calls.push(`del:${key}`);
        return tier.del(key);
      },
    };
    await createCacheStack([spied]).write('k', 'v');
    expect(calls).toEqual([]);
    expect(tier.held.get('k')).toBe('v');
  });
});
