// The ladder's order is data, not control flow, so nothing but a test stops a deployment from
// being walked the wrong way round — and a read that skips the write-back quietly costs every
// later reader the same round trip. Order, write-back, expiry and the refusal of a single tier
// are the four things pinned.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { createLruTier } from './lru';
import { recentTierFailures, resetTierFailures } from './tier-failures';
import type { CacheEntry, CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack, isExpired, nowMs, sortTiers, TIER_ORDER } from './tiers';

/** Manual clock: `.now()` returns a `Date`, mirroring the real `Clock` contract. */
function fakeClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

/** A clock whose `.now()` returns raw epoch ms instead of a `Date`. */
function fakeNumericClock(startMs: number): { now(): number } {
  return { now: () => startMs };
}

/** Minimal, in-memory `CacheTier` that records every call it receives. */
function fakeTier(name: CacheTier['name'], calls: string[]): CacheTier {
  const store = new Map<string, CacheEntry<unknown>>();
  return {
    name,
    get<T>(key: string) {
      calls.push(`get:${name}:${key}`);
      return Promise.resolve(store.get(key) as CacheEntry<T> | undefined);
    },
    set<T>(key: string, value: T, options?: CacheSetOptions) {
      calls.push(`set:${name}:${key}`);
      store.set(key, { value, tags: options?.tags ?? [] });
      return Promise.resolve();
    },
    del(key: string) {
      calls.push(`del:${name}:${key}`);
      store.delete(key);
      return Promise.resolve();
    },
    invalidateTags() {
      return Promise.resolve({ tier: name, keys: [] });
    },
  };
}

/** Same shape as `fakeTier`, but pre-seeded with a value so `get` hits immediately. */
function seededTier(
  name: CacheTier['name'],
  calls: string[],
  key: string,
  value: unknown,
): CacheTier {
  const tier = fakeTier(name, calls);
  return {
    ...tier,
    get<T>(k: string) {
      calls.push(`get:${name}:${k}`);
      if (k === key) return Promise.resolve({ value, tags: [] } as CacheEntry<T>);
      return Promise.resolve(undefined);
    },
  };
}

/** A tier that rejects the named operations; everything else behaves like `fakeTier`. */
function refusingTier(
  name: CacheTier['name'],
  refuse: readonly ('get' | 'set' | 'del')[],
  calls: string[],
): CacheTier {
  const tier = fakeTier(name, calls);
  const refused = (op: string, key: string): Promise<never> => {
    calls.push(`${op}:${name}:${key}`);
    return Promise.reject(new Error(`${name} refused ${op}`));
  };
  return {
    ...tier,
    get<T>(key: string) {
      return refuse.includes('get') ? refused('get', key) : tier.get<T>(key);
    },
    set<T>(key: string, value: T, options?: CacheSetOptions) {
      return refuse.includes('set') ? refused('set', key) : tier.set(key, value, options);
    },
    del(key: string) {
      return refuse.includes('del') ? refused('del', key) : tier.del(key);
    },
  };
}

describe('TIER_ORDER', () => {
  test('is request-memo, lru, redis, cdn in that order', () => {
    expect(TIER_ORDER).toEqual(['request-memo', 'lru', 'redis', 'cdn']);
  });
});

describe('sortTiers', () => {
  test('reorders tiers to TIER_ORDER regardless of input order', () => {
    const calls: string[] = [];
    const cdn = fakeTier('cdn', calls);
    const lru = fakeTier('lru', calls);
    const redis = fakeTier('redis', calls);

    const sorted = sortTiers([cdn, redis, lru]);

    expect(sorted.map((t) => t.name)).toEqual(['lru', 'redis', 'cdn']);
  });

  test('does not mutate the input array', () => {
    const calls: string[] = [];
    const cdn = fakeTier('cdn', calls);
    const lru = fakeTier('lru', calls);
    const input = [cdn, lru];

    sortTiers(input);

    expect(input).toEqual([cdn, lru]);
  });
});

describe('nowMs', () => {
  test('returns getTime() when the clock reads a Date', () => {
    const clock = fakeClock(1_700_000_000_000);
    expect(nowMs(clock)).toBe(1_700_000_000_000);
  });

  test('returns the number itself when the clock reads epoch ms', () => {
    const clock = fakeNumericClock(1_700_000_000_000) as unknown as Clock;
    expect(nowMs(clock)).toBe(1_700_000_000_000);
  });
});

describe('isExpired', () => {
  test('an entry with no expiresAt never expires', () => {
    const entry: CacheEntry<string> = { value: 'v', tags: [] };
    expect(isExpired(entry, 0)).toBe(false);
    expect(isExpired(entry, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test('expiresAt <= at is expired, including exactly at the boundary', () => {
    const entry: CacheEntry<string> = { value: 'v', expiresAt: 1_000, tags: [] };
    expect(isExpired(entry, 1_000)).toBe(true);
    expect(isExpired(entry, 1_001)).toBe(true);
  });

  test('expiresAt > at is not yet expired', () => {
    const entry: CacheEntry<string> = { value: 'v', expiresAt: 1_000, tags: [] };
    expect(isExpired(entry, 999)).toBe(false);
  });
});

describe('createCacheStack read', () => {
  test('a miss on every tier calls load() once and writes the value to every tier', async () => {
    const calls: string[] = [];
    const lru = fakeTier('lru', calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    let loads = 0;
    const value = await stack.read('k', () => {
      loads += 1;
      return Promise.resolve('loaded');
    });

    expect(value).toBe('loaded');
    expect(loads).toBe(1);
    expect(calls).toEqual(['get:lru:k', 'get:redis:k', 'set:lru:k', 'set:redis:k']);
  });

  test('a hit on a further tier populates every closer tier but not itself, and skips further tiers', async () => {
    const calls: string[] = [];
    const lru = fakeTier('lru', calls);
    const redis = seededTier('redis', calls, 'k', 'from-redis');
    const cdn = fakeTier('cdn', calls);
    const stack = createCacheStack([cdn, redis, lru]);

    const value = await stack.read('k', () => Promise.resolve('should-not-load'));

    expect(value).toBe('from-redis');
    // lru (index 0) is closer than redis (index 1, the hit) and gets populated.
    // cdn (index 2) is further than the hit and is never touched.
    expect(calls).toEqual(['get:lru:k', 'get:redis:k', 'set:lru:k']);
  });

  test('a hit on the first tier populates no other tier', async () => {
    const calls: string[] = [];
    const lru = seededTier('lru', calls, 'k', 'from-lru');
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    const value = await stack.read('k', () => Promise.resolve('should-not-load'));

    expect(value).toBe('from-lru');
    expect(calls).toEqual(['get:lru:k']);
  });
});

describe('createCacheStack write', () => {
  test('calls set() on every tier once, in tier order', async () => {
    const calls: string[] = [];
    const cdn = fakeTier('cdn', calls);
    const lru = fakeTier('lru', calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([cdn, redis, lru]);

    await stack.write('k', 'v');

    expect(calls).toEqual(['set:lru:k', 'set:redis:k', 'set:cdn:k']);
  });
});

describe('createCacheStack drop', () => {
  test('calls del() on every tier once', async () => {
    const calls: string[] = [];
    const lru = fakeTier('lru', calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    await stack.drop('k');

    expect(calls).toEqual(['del:lru:k', 'del:redis:k']);
  });
});

describe('createCacheStack: a refusing tier never fails the business call', () => {
  beforeEach(() => {
    resetTierFailures();
  });

  test('an entry over the LRU byte budget still comes back from read()', async () => {
    // The real refusal this guards: `LruCache.set` throws X_CACHE_TOO_LARGE, and before the
    // guard that throw travelled straight out of `read()` as if the source had failed.
    const lru = createLruTier({ maxBytes: 64 });
    const stack = createCacheStack([lru]);

    const value = await stack.read('feed', () => Promise.resolve('x'.repeat(4096)));

    expect(value).toBe('x'.repeat(4096));
    expect(recentTierFailures()[0]).toMatchObject({
      tier: 'lru',
      op: 'set',
      key: 'feed',
      code: 'X_CACHE_TOO_LARGE',
    });
  });

  test('a refused write-back after load() still returns the value and still fills later tiers', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['set'], calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    const value = await stack.read('k', () => Promise.resolve('loaded'));

    expect(value).toBe('loaded');
    expect(calls).toEqual(['get:lru:k', 'get:redis:k', 'set:lru:k', 'set:redis:k']);
    expect(recentTierFailures().length).toBe(1);
  });

  test('a tier that refuses get is skipped, and a further tier still answers', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['get'], calls);
    const redis = seededTier('redis', calls, 'k', 'from-redis');
    const stack = createCacheStack([redis, lru]);

    const value = await stack.read('k', () => Promise.resolve('should-not-load'));

    expect(value).toBe('from-redis');
    expect(recentTierFailures()[0]).toMatchObject({ tier: 'lru', op: 'get', key: 'k' });
  });

  test('every tier refusing get falls through to load(), which runs exactly once', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['get'], calls);
    const redis = refusingTier('redis', ['get'], calls);
    const stack = createCacheStack([redis, lru]);

    let loads = 0;
    const value = await stack.read('k', () => {
      loads += 1;
      return Promise.resolve('loaded');
    });

    expect(value).toBe('loaded');
    expect(loads).toBe(1);
    expect(recentTierFailures().map((failure) => failure.tier)).toEqual(['redis', 'lru']);
  });

  test('a refused populate-up after a hit still returns the hit', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['set'], calls);
    const redis = seededTier('redis', calls, 'k', 'from-redis');
    const stack = createCacheStack([redis, lru]);

    const value = await stack.read('k', () => Promise.resolve('should-not-load'));

    expect(value).toBe('from-redis');
    expect(recentTierFailures()[0]).toMatchObject({ tier: 'lru', op: 'set' });
  });

  test('load() itself still throws — it is the business read, not a tier', async () => {
    const calls: string[] = [];
    const stack = createCacheStack([fakeTier('lru', calls)]);

    const read = stack.read('k', () => Promise.reject(new Error('source is down')));

    await expect(read).rejects.toThrow('source is down');
    expect(recentTierFailures()).toEqual([]);
  });

  test('write() survives a refusing tier and still writes the rest', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['set'], calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    await stack.write('k', 'v');

    expect(calls).toEqual(['set:lru:k', 'set:redis:k']);
    expect(recentTierFailures()[0]).toMatchObject({ tier: 'lru', op: 'set' });
  });

  test('drop() survives a refusing tier and still drops the rest', async () => {
    const calls: string[] = [];
    const lru = refusingTier('lru', ['del'], calls);
    const redis = fakeTier('redis', calls);
    const stack = createCacheStack([redis, lru]);

    await stack.drop('k');

    expect(calls).toEqual(['del:lru:k', 'del:redis:k']);
    expect(recentTierFailures()[0]).toMatchObject({ tier: 'lru', op: 'del', key: 'k' });
  });
});

describe('createCacheStack tiers', () => {
  test('exposes tiers sorted to TIER_ORDER, not raw input order', () => {
    const calls: string[] = [];
    const cdn = fakeTier('cdn', calls);
    const redis = fakeTier('redis', calls);
    const lru = fakeTier('lru', calls);
    const stack = createCacheStack([cdn, redis, lru]);

    expect(stack.tiers.map((t) => t.name)).toEqual(['lru', 'redis', 'cdn']);
  });
});
