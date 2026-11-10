// The cache tier conformance suite over the request memo and the LRU, and the proof it can fail: a
// tier whose row bust reads the whole entity, and one that hands every reader one live object.

import { describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import { lruTier, memoTier } from '@ultimat3/cache';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { CACHE_TIER_CHECKS, cacheTierConformance } from './cache-tier-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the request memo tier'), () => {
  behavesLike(cacheTierConformance, () => memoTier());
});

describe(testName('unit', 'the lru tier'), () => {
  behavesLike(cacheTierConformance, () => lruTier({ rng: () => 0 }));
});

const check = (name: string) => {
  const found = CACHE_TIER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

const inRequest = (run: () => Promise<void>): Promise<void> => runWithContext(ctxOf(), run);

describe(testName('unit', 'a tier that breaks the contract fails conformance'), () => {
  test('a row bust that reads "everything of the entity"', async () => {
    const inner = lruTier({ rng: () => 0 });
    const coarse: CacheTier = {
      ...inner,
      invalidateTags: (tags) => inner.invalidateTags(tags.map((each) => ({ entity: each.entity }))),
    };
    const row = check('a ROW bust');
    await inRequest(async () => {
      await expect(row.run(coarse)).rejects.toThrow();
      await row.run(lruTier({ rng: () => 0 }));
    });
  });

  test('a tier that keeps the caller’s object by reference', async () => {
    const held = new Map<string, unknown>();
    const inner = lruTier({ rng: () => 0 });
    const byReference: CacheTier = {
      ...inner,
      async get<T>(key: string) {
        return held.has(key) ? { value: held.get(key) as T, tags: [] } : undefined;
      },
      async set(key, value) {
        held.set(key, value);
      },
    };
    const shared = check('mutating the written object');
    await inRequest(async () => {
      await expect(shared.run(byReference)).rejects.toThrow();
      await shared.run(memoTier());
    });
  });

  test('every check has a name of its own', () => {
    const names = CACHE_TIER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
