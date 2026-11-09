// One question, one answer, whichever RUNG is asked. `tagMatches` is this package's declared
// invalidation semantic and three tiers implement it independently — the memo through
// `tagsIntersect`, the LRU through two indexes, the shared tier through bucket keys on a wire.
// Each case drives every tier that can hold the entry, in ONE test, so no rung can move alone.
//
// The memo and the LRU are real objects and answer with real behaviour. The shared tier runs on the
// fake, which holds its sorted sets as state (plain commands, no Lua), so it answers with
// survivors too; `redis.live.test.ts` runs the same two busts against a real server.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { CacheTooLargeError, CacheTtlInvalidError } from './errors';
import { lruTier } from './lru';
import { memoTier } from './memo';
import { bucketsJoined, bucketsRead, fakeRedis, tierFor } from './redis-fake-fixture';
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

describe('a ROW bust spares the other rows of its entity', () => {
  test('memo, lru and the shared tier all read `tagMatches`, not "everything post"', async () => {
    // `tagMatches(tag('post','1'), tag('post','2'))` is FALSE and this is the one place three
    // implementations of it are compared. The shared tier used to join a row-tagged key to the
    // COLLECTION bucket and then read that bucket back on a row bust, so `invalidateTags([tag(
    // 'post','1')])` deleted every post-tagged key in Redis while the LRU one rung closer kept
    // exactly the row that changed — every single-row write emptied the shared tier.
    const memo = memoTier();
    await runWithContext(ctxOf(), async () => {
      await seed(memo);
      expect([...(await memo.invalidateTags([tag('post', '1')])).keys].sort()).toEqual([
        'feed',
        'post-1',
      ]);
      expect(await survivors(memo)).toEqual(['post-2']);
    });

    const lru = lruTier({ rng: () => 0 });
    await seed(lru);
    expect([...(await lru.invalidateTags([tag('post', '1')])).keys].sort()).toEqual([
      'feed',
      'post-1',
    ]);
    expect(await survivors(lru)).toEqual(['post-2']);

    // The same verdict from the shared tier, and the reason on the wire: the bust reads the row's
    // bucket and the bare collection tag's — never the entity index that holds `post-2`.
    const client = fakeRedis();
    const redis = tierFor(client);
    await seed(redis);
    client.sent.length = 0;

    expect([...(await redis.invalidateTags([tag('post', '1')])).keys].sort()).toEqual([
      'feed',
      'post-1',
    ]);
    expect(await survivors(redis)).toEqual(['post-2']);
    expect(bucketsRead(client.sent)).toEqual(['x:t2:{post}:1', 'x:t2:{post}']);
  });
});

describe('a COLLECTION bust takes every row of its entity', () => {
  test('memo, lru and the shared tier all clear the rows as well as the list', async () => {
    // The other half of `tagMatches`: `tagMatches(tag('post'), tag('post','2'))` is TRUE. A tier
    // that read only the bare collection tag's bucket here would leave every row cached with
    // nothing left to clear it — the failure the entity index exists to prevent, and the reason
    // it is a second bucket rather than a narrowing of the first.
    const memo = memoTier();
    await runWithContext(ctxOf(), async () => {
      await seed(memo);
      await memo.invalidateTags([tag('post')]);
      expect(await survivors(memo)).toEqual([]);
    });

    const lru = lruTier({ rng: () => 0 });
    await seed(lru);
    await lru.invalidateTags([tag('post')]);
    expect(await survivors(lru)).toEqual([]);

    const client = fakeRedis();
    const redis = tierFor(client);
    await seed(redis);
    client.sent.length = 0;

    await redis.invalidateTags([tag('post')]);
    expect(await survivors(redis)).toEqual([]);
    // The index alone: every key of the entity joined it, the collection tag's bucket included.
    expect(bucketsRead(client.sent)).toEqual(['x:e2:{post}']);
    // The index and the collection tag's bucket are emptied. A ROW bucket keeps its dead member
    // — the bust never learns which rows a key was tagged with — until a write to it prunes the
    // member past its score or the bucket's own lease ends: bounded, and harmless to a later bust.
    expect(client.members('x:e2:{post}')).toEqual([]);
    expect(client.members('x:t2:{post}')).toEqual([]);
  });

  test('every key a row write joins is reachable from the entity index', async () => {
    // The write half of the same claim, and the mutation it catches: drop `entityKey` from
    // `writeBucketsFor` and a row-tagged key is in no bucket a collection bust reads — it serves
    // its pre-bust value for the whole TTL with `report.errors` empty.
    const client = fakeRedis();
    await tierFor(client).set('post-1', 'one', { ttlMs: 60_000, tags: [tag('post', '1')] });

    expect(bucketsJoined(client.sent)).toEqual(['x:t2:{post}:1', 'x:e2:{post}']);
  });
});

describe('ttlMs is positive and finite on EVERY rung', () => {
  test('memo, lru and the shared tier all refuse a zero lease', async () => {
    // `0` used to mean "never expires" in one tier and `EX 1` in another; the memo took it
    // silently long after both were fixed. In a stack that is worse than either, because
    // `bestEffort` swallows the two refusals and the read still hits — out of the one tier that
    // should never have held it.
    const memo = memoTier();
    await runWithContext(ctxOf(), async () => {
      await expect(memo.set('k', 'v', { ttlMs: 0 })).rejects.toThrow(CacheTtlInvalidError);
    });

    await expect(lruTier().set('k', 'v', { ttlMs: 0 })).rejects.toThrow(CacheTtlInvalidError);
    await expect(tierFor(fakeRedis()).set('k', 'v', { ttlMs: 0 })).rejects.toThrow(
      CacheTtlInvalidError,
    );
  });

  test('the memo refuses it OUTSIDE a request too, where it stores nothing at all', async () => {
    // The refusal is the caller's miswiring, not a property of the store: a no-op tier that
    // accepted `ttlMs: 0` would make the same call throw or resolve depending on whether a
    // request happened to be in scope.
    await expect(memoTier().set('k', 'v', { ttlMs: 0 })).rejects.toThrow(CacheTtlInvalidError);
  });
});

describe('an oversized value is refused on EVERY bounded rung', () => {
  test('the lru and the shared tier both answer X_CACHE_TOO_LARGE, and redis holds nothing', async () => {
    // The LRU refused a value over its budget; Redis took anything, so the same `set` pushed a
    // multi-megabyte value into the store every replica shares and blocked it on every read.
    const big = 'x'.repeat(4_096);
    await expect(lruTier({ maxBytes: 1_024 }).set('k', big)).rejects.toThrow(CacheTooLargeError);

    const client = fakeRedis();
    const refused = tierFor(client, { maxValueBytes: 1_024 }).set('k', big, {
      tags: [tag('post')],
    });
    await expect(refused).rejects.toThrow(CacheTooLargeError);
    await expect(refused).rejects.toMatchObject({ code: 'X_CACHE_TOO_LARGE' });
    // Refused before any bucket is joined: nothing left behind to bust.
    expect(client.sent).toEqual([]);
  });

  test('the shared tier counts UTF-8 bytes, not UTF-16 code units', async () => {
    // 400 code units, 1,200 bytes: a `text.length` budget would let it through.
    const client = fakeRedis();
    await expect(
      tierFor(client, { maxValueBytes: 1_100 }).set('k', '€'.repeat(400)),
    ).rejects.toThrow(CacheTooLargeError);
    await tierFor(client, { maxValueBytes: 1_300 }).set('k', '€'.repeat(400));
    expect((await tierFor(client).get('k'))?.value).toBe('€'.repeat(400));
  });

  test('the default shared-tier budget is 1 MiB, and a non-integer budget is refused', async () => {
    const client = fakeRedis();
    await expect(tierFor(client).set('k', 'x'.repeat(1_048_577))).rejects.toThrow(
      CacheTooLargeError,
    );
    expect(() => tierFor(client, { maxValueBytes: Number.NaN })).toThrow('X_CACHE_LIMIT_INVALID');
  });
});
