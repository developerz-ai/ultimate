// One question, one answer, whichever RUNG is asked. `tagMatches` is this package's declared
// invalidation semantic and three tiers implement it independently — the memo through
// `tagsIntersect`, the LRU through two indexes, the shared tier through bucket keys on a wire.
// Each case drives every tier that can hold the entry, in ONE test, so no rung can move alone.
//
// The memo and the LRU are real objects and answer with real behaviour. The shared tier's own
// SMEMBERS is a real server's (`redis.live.test.ts` runs the same two busts against one), so what
// is asserted here is the thing a fake CAN prove: which buckets a bust reads. A bucket it never
// reads is a key it can never delete, which is the whole of the claim.

import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { CacheTtlInvalidError } from './errors';
import { createLruTier } from './lru';
import { createMemoTier } from './memo';
import { REDIS_INVALIDATE_SCRIPT } from './redis';
import { fakeRedis, keysOf, tierFor } from './redis-fake';
import { tag } from './tags';
import type { CacheTier } from './tiers';

/** The three keys every bust case below is judged on: one row, its neighbour, and a list. */
const seed = async (tier: CacheTier): Promise<void> => {
  await tier.set('post-1', 'one', { ttlMs: 60_000, tags: [tag('post', '1')] });
  await tier.set('post-2', 'two', { ttlMs: 60_000, tags: [tag('post', '2')] });
  await tier.set('feed', 'list', { ttlMs: 60_000, tags: [tag('post')] });
};

const survivors = async (tier: CacheTier): Promise<string[]> => {
  const found: string[] = [];
  for (const key of ['post-1', 'post-2', 'feed']) {
    if ((await tier.get(key)) !== undefined) found.push(key);
  }
  return found;
};

/** Every bucket the tier handed to the invalidation script, in call order. */
const bustBuckets = (sent: readonly string[][]): string[] =>
  sent.filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT).flatMap((entry) => keysOf(entry));

describe('a ROW bust spares the other rows of its entity', () => {
  test('memo, lru and the shared tier all read `tagMatches`, not "everything post"', async () => {
    // `tagMatches(tag('post','1'), tag('post','2'))` is FALSE and this is the one place three
    // implementations of it are compared. The shared tier used to join a row-tagged key to the
    // COLLECTION bucket and then read that bucket back on a row bust, so `invalidateTags([tag(
    // 'post','1')])` deleted every post-tagged key in Redis while the LRU one rung closer kept
    // exactly the row that changed — every single-row write emptied the shared tier.
    const memo = createMemoTier();
    await runWithContext(createContext(), async () => {
      await seed(memo);
      expect([...(await memo.invalidateTags([tag('post', '1')])).keys].sort()).toEqual([
        'feed',
        'post-1',
      ]);
      expect(await survivors(memo)).toEqual(['post-2']);
    });

    const lru = createLruTier({ rng: () => 0 });
    await seed(lru);
    expect([...(await lru.invalidateTags([tag('post', '1')])).keys].sort()).toEqual([
      'feed',
      'post-1',
    ]);
    expect(await survivors(lru)).toEqual(['post-2']);

    // The same verdict on the wire: `post-2`'s only bucket is `x:t:{post}:2`, and the bust asks
    // for the row's bucket and the bare collection tag's — never the entity index that holds it.
    const client = fakeRedis();
    const redis = tierFor(client);
    await seed(redis);
    client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
    client.sent.length = 0;

    await redis.invalidateTags([tag('post', '1')]);
    expect(bustBuckets(client.sent)).toEqual(['x:t:{post}:1', 'x:t:{post}']);
    expect(bustBuckets(client.sent)).not.toContain('x:e:{post}');
  });
});

describe('a COLLECTION bust takes every row of its entity', () => {
  test('memo, lru and the shared tier all clear the rows as well as the list', async () => {
    // The other half of `tagMatches`: `tagMatches(tag('post'), tag('post','2'))` is TRUE. A tier
    // that read only the bare collection tag's bucket here would leave every row cached with
    // nothing left to clear it — the failure the entity index exists to prevent, and the reason
    // it is a second bucket rather than a narrowing of the first.
    const memo = createMemoTier();
    await runWithContext(createContext(), async () => {
      await seed(memo);
      await memo.invalidateTags([tag('post')]);
      expect(await survivors(memo)).toEqual([]);
    });

    const lru = createLruTier({ rng: () => 0 });
    await seed(lru);
    await lru.invalidateTags([tag('post')]);
    expect(await survivors(lru)).toEqual([]);

    const client = fakeRedis();
    const redis = tierFor(client);
    await seed(redis);
    client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
    client.sent.length = 0;

    await redis.invalidateTags([tag('post')]);
    // The index first, because it is the answer; the collection tag's own bucket second, so a
    // deployment upgrading into this layout with `buildId: null` does not miss its old keys.
    expect(bustBuckets(client.sent)).toEqual(['x:e:{post}', 'x:t:{post}']);
  });

  test('every key a row write joins is reachable from the entity index', async () => {
    // The write half of the same claim, and the mutation it catches: drop `entityKey` from
    // `writeBucketsFor` and a row-tagged key is in no bucket a collection bust reads — it serves
    // its pre-bust value for the whole TTL with `report.errors` empty.
    const client = fakeRedis();
    await tierFor(client).set('post-1', 'one', { ttlMs: 60_000, tags: [tag('post', '1')] });

    const joined = client.sent
      .filter((entry) => entry[0] === 'EVAL' && entry[2] === '1')
      .map((entry) => String(entry[3]));
    expect(joined).toEqual(['x:t:{post}:1', 'x:e:{post}']);
  });
});

describe('ttlMs is positive and finite on EVERY rung', () => {
  test('memo, lru and the shared tier all refuse a zero lease', async () => {
    // `0` used to mean "never expires" in one tier and `EX 1` in another; the memo took it
    // silently long after both were fixed. In a stack that is worse than either, because
    // `bestEffort` swallows the two refusals and the read still hits — out of the one tier that
    // should never have held it.
    const memo = createMemoTier();
    await runWithContext(createContext(), async () => {
      await expect(memo.set('k', 'v', { ttlMs: 0 })).rejects.toThrow(CacheTtlInvalidError);
    });

    await expect(createLruTier().set('k', 'v', { ttlMs: 0 })).rejects.toThrow(CacheTtlInvalidError);
    await expect(tierFor(fakeRedis()).set('k', 'v', { ttlMs: 0 })).rejects.toThrow(
      CacheTtlInvalidError,
    );
  });

  test('the memo refuses it OUTSIDE a request too, where it stores nothing at all', async () => {
    // The refusal is the caller's miswiring, not a property of the store: a no-op tier that
    // accepted `ttlMs: 0` would make the same call throw or resolve depending on whether a
    // request happened to be in scope.
    await expect(createMemoTier().set('k', 'v', { ttlMs: 0 })).rejects.toThrow(
      CacheTtlInvalidError,
    );
  });
});
