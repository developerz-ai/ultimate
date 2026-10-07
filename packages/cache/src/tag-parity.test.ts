// `tagMatches` is the one invalidation rule, and four tiers implement it four ways: the memo
// through `tagsIntersect`, the LRU through two indexes, the shared tier through bucket keys, the
// CDN through the keys a response carries and the keys a bust purges. ONE fixture table goes
// through all four here, so no tier can keep a private reading of "does this bust reach that entry".

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import type { PurgeDriver } from './cdn';
import { cacheHeaders, cdnTier } from './cdn';
import { lruTier } from './lru';
import { memoTier } from './memo';
import { REDIS_INVALIDATE_SCRIPT, REDIS_TAG_MEMBER_SCRIPT } from './redis';
import { fakeRedis, keysOf, tierFor } from './redis-fake-fixture';
import type { CacheTag } from './tags';
import { tag, tagsIntersect } from './tags';
import type { CacheTier } from './tiers';

/** What each tier holds before every bust: two rows, their list, another entity, and no tags. */
const OWNED: Readonly<Record<string, readonly CacheTag[]>> = {
  'post-1': [tag('post', '1')],
  'post-2': [tag('post', '2')],
  feed: [tag('post')],
  'user-1': [tag('user', '1')],
  plain: [],
};

interface Case {
  readonly name: string;
  readonly bust: readonly CacheTag[];
  readonly reaches: readonly string[];
}

const CASES: readonly Case[] = [
  { name: 'a row', bust: [tag('post', '1')], reaches: ['feed', 'post-1'] },
  { name: 'a collection', bust: [tag('post')], reaches: ['feed', 'post-1', 'post-2'] },
  { name: 'a row of another entity', bust: [tag('user', '1')], reaches: ['user-1'] },
  { name: 'a row nothing holds', bust: [tag('post', '3')], reaches: ['feed'] },
  { name: 'an entity nothing holds', bust: [tag('comment')], reaches: [] },
  {
    name: 'two tags at once',
    bust: [tag('post', '2'), tag('user')],
    reaches: ['feed', 'post-2', 'user-1'],
  },
];

const seed = async (tier: CacheTier): Promise<void> => {
  for (const [key, tags] of Object.entries(OWNED)) {
    await tier.set(key, key, { ttlMs: 60_000, tags });
  }
};

/** Real behaviour: what is gone after the bust is what the bust reached. */
const clearedFrom = async (tier: CacheTier, bust: readonly CacheTag[]): Promise<string[]> => {
  await seed(tier);
  await tier.invalidateTags(bust);
  const gone: string[] = [];
  for (const key of Object.keys(OWNED)) {
    if ((await tier.get(key)) === undefined) gone.push(key);
  }
  return gone.sort();
};

const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
  left.some((value) => right.includes(value));

/**
 * The fake cannot run Lua, so the shared tier is judged on what a recorder CAN prove: a key is
 * reachable by a bust exactly when a bucket its write joined is a bucket the bust reads.
 */
const reachedOnTheWire = async (bust: readonly CacheTag[]): Promise<string[]> => {
  const client = fakeRedis();
  const tier = tierFor(client);
  await seed(tier);
  const joined = new Map<string, string[]>();
  for (const entry of client.sent) {
    if (entry[0] !== 'EVAL' || entry[1] !== REDIS_TAG_MEMBER_SCRIPT) continue;
    const key = String(entry[4]).slice('x:c:'.length);
    joined.set(key, [...(joined.get(key) ?? []), String(entry[3])]);
  }
  client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
  client.sent.length = 0;
  await tier.invalidateTags(bust);
  const read = client.sent
    .filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT)
    .flatMap((entry) => keysOf(entry));
  return Object.keys(OWNED)
    .filter((key) => overlaps(joined.get(key) ?? [], read))
    .sort();
};

/** The edge purges by exact key: a response is cleared when a key it CARRIES is a key PURGED. */
const purgedAtTheEdge = async (
  bust: readonly CacheTag[],
  header: 'Surrogate-Key' | 'Cache-Tag',
): Promise<string[]> => {
  const purged: string[] = [];
  const driver: PurgeDriver = {
    name: 'spy',
    purge(keys) {
      purged.push(...keys);
      return Promise.resolve(keys);
    },
    purgeAll: () => Promise.resolve(),
  };
  await cdnTier({ purge: driver }).invalidateTags(bust);
  const separator = header === 'Surrogate-Key' ? ' ' : ',';
  return Object.entries(OWNED)
    .filter(([, tags]) => overlaps(cacheHeaders({ tags })[header]?.split(separator) ?? [], purged))
    .map(([key]) => key)
    .sort();
};

describe('the fixture table is `tagMatches`, not a second opinion', () => {
  for (const { name, bust, reaches } of CASES) {
    test(`${name} reaches exactly what tagsIntersect says`, () => {
      const byRule = Object.entries(OWNED)
        .filter(([, tags]) => tagsIntersect(bust, tags))
        .map(([key]) => key)
        .sort();
      expect(byRule).toEqual([...reaches]);
    });
  }
});

describe('one bust, one answer, on every tier', () => {
  for (const { name, bust, reaches } of CASES) {
    test(`request-memo: busting ${name}`, async () => {
      await runWithContext(ctxOf(), async () => {
        expect(await clearedFrom(memoTier(), bust)).toEqual([...reaches]);
      });
    });

    test(`lru: busting ${name}`, async () => {
      expect(await clearedFrom(lruTier({ rng: () => 0 }), bust)).toEqual([...reaches]);
    });

    test(`redis: busting ${name}`, async () => {
      expect(await reachedOnTheWire(bust)).toEqual([...reaches]);
    });

    test(`cdn: busting ${name}`, async () => {
      // Both spellings of the list: Fastly reads one header and Cloudflare the other.
      expect(await purgedAtTheEdge(bust, 'Surrogate-Key')).toEqual([...reaches]);
      expect(await purgedAtTheEdge(bust, 'Cache-Tag')).toEqual([...reaches]);
    });
  }
});
