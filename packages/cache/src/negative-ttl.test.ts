// `negativeTtlMs`: the lease a `null` gets. A lookup for a row that has not replicated yet
// answers `null` 40ms before it lands, and holding that for the positive TTL tells every reader
// "does not exist" for five minutes. The stack is the only layer that sees what `load()` answered,
// so this is the only layer that can decide.

import { describe, expect, test } from 'bun:test';
import type { CacheSetOptions, CacheTier } from './tiers';
import { createCacheStack } from './tiers';

describe('createCacheStack read: a null load can carry its own TTL', () => {
  test('negativeTtlMs is selected for null and undefined, and ignored for a real value', async () => {
    // A row that has not replicated yet answers `null` 40ms before it lands. Held for the
    // positive TTL, every reader is told "does not exist" for five minutes.
    const writes: CacheSetOptions[] = [];
    const tier: CacheTier = {
      name: 'lru',
      get() {
        return Promise.resolve(undefined);
      },
      set(_key: string, _value: unknown, options?: CacheSetOptions) {
        writes.push(options ?? {});
        return Promise.resolve();
      },
      del() {
        return Promise.resolve();
      },
      invalidateTags() {
        return Promise.resolve({ tier: 'lru' as const, keys: [] });
      },
    };
    const stack = createCacheStack([tier]);
    const options = { ttlMs: 300_000, negativeTtlMs: 5_000 };

    await stack.read('a', () => Promise.resolve(null), options);
    await stack.read('b', () => Promise.resolve(undefined), options);
    await stack.read('c', () => Promise.resolve('row'), options);

    expect(writes.map((entry) => entry.ttlMs)).toEqual([5_000, 5_000, 300_000]);
  });

  test('with no negativeTtlMs a null is written on the positive ttl, unchanged', async () => {
    const writes: CacheSetOptions[] = [];
    const stack = createCacheStack([
      {
        name: 'lru',
        get: () => Promise.resolve(undefined),
        set: (_k: string, _v: unknown, options?: CacheSetOptions) => {
          writes.push(options ?? {});
          return Promise.resolve();
        },
        del: () => Promise.resolve(),
        invalidateTags: () => Promise.resolve({ tier: 'lru' as const, keys: [] }),
      },
    ]);

    await stack.read('a', () => Promise.resolve(null), { ttlMs: 300_000 });

    expect(writes).toEqual([{ ttlMs: 300_000 }]);
  });
});
