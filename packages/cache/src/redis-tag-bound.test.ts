// A tag bucket holds live keys, not history, and a bust of a big one costs pages, not one reply.
// Before this, only a bust removed members: an entity written constantly and never invalidated
// collected every key it ever wrote, and its first bust read millions in one call — on the
// post-commit path, in ~3,000 sequential round trips. The fake holds sorted sets as real state
// (plain commands, no Lua), so the bound and the round-trip count are measured, not restated.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { RedisLike } from './redis';
import { BUST_PAGE_SIZE, TAG_GRACE_MS } from './redis-buckets';
import type { FakeRedis } from './redis-fake-fixture';
import { fakeRedis, roundTrips, tierFor } from './redis-fake-fixture';
import { tag } from './tags';

const WRITES = 10_000;

describe('a tag bucket stays bounded under write-only load', () => {
  test('10k short-lived keys, then one more write: the bucket holds the one live member', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const client = fakeRedis();
    const tier = tierFor(client, { clock });
    const tags = [tag('post', '1')];
    await Promise.all(
      Array.from({ length: WRITES }, (_, i) =>
        tier.set(`k${String(i)}`, i, { ttlMs: 1_000, tags }),
      ),
    );
    expect(client.members('x:t2:{post}:1')).toHaveLength(WRITES);

    // Every one of them has expired, and the skew grace has passed too.
    clock.advance(1_000 + TAG_GRACE_MS + 1);
    await tier.set('fresh', 'v', { ttlMs: 1_000, tags });

    expect(client.members('x:t2:{post}:1')).toEqual(['x:c:fresh']);
    expect(client.members('x:e2:{post}')).toEqual(['x:c:fresh']);
  });

  test('a member inside the skew grace survives the prune, so a skewed pod cannot orphan it', async () => {
    // Scored by the WRITER's clock. A pod whose clock runs ahead prunes with its own `now`; the
    // grace is what keeps a still-live value key reachable by tag across that skew.
    const clock = frozenClock(1_700_000_000_000);
    const client = fakeRedis();
    const tier = tierFor(client, { clock });
    await tier.set('old', 'v', { ttlMs: 1_000, tags: [tag('post')] });
    clock.advance(1_000 + TAG_GRACE_MS - 1);
    await tier.set('new', 'v', { ttlMs: 1_000, tags: [tag('post')] });

    expect(client.members('x:t2:{post}')).toEqual(['x:c:old', 'x:c:new']);
  });
});

describe('a bust of a big bucket is paged and pipelined', () => {
  test('10k members clear in at most 100 sequential round trips', async () => {
    const seeding = fakeRedis();
    const seeded = tierFor(seeding);
    await Promise.all(
      Array.from({ length: WRITES }, (_, i) =>
        seeded.set(`k${String(i)}`, i, { ttlMs: 60_000, tags: [tag('post', '1')] }),
      ),
    );
    const counted = roundTrips(seeding);
    seeding.sent.length = 0;

    const result = await tierFor(counted).invalidateTags([tag('post', '1')]);

    expect(result.keys).toHaveLength(WRITES);
    expect(counted.trips()).toBeLessThanOrEqual(100);
    expect(seeding.members('x:t2:{post}:1')).toEqual([]);
    expect(seeding.members('x:e2:{post}')).toEqual([]);
    // Paged: no single read asks for more than one page.
    for (const read of seeding.sent.filter((entry) => entry[0] === 'ZSCAN')) {
      expect(Number(read.at(-1))).toBeLessThanOrEqual(BUST_PAGE_SIZE);
    }
    // `UNLINK`, never a blocking `DEL`, for every value key.
    expect(seeding.sent.some((entry) => entry[0] === 'DEL')).toBe(false);
  });

  test('a tie group wider than a page is read whole', async () => {
    // Every member written in one millisecond with one ttl shares one score. A cursor that moved
    // on score alone would re-read the first page forever or skip the rest of the group.
    const clock = frozenClock(1_700_000_000_000);
    const client = fakeRedis();
    const tier = tierFor(client, { clock });
    const count = BUST_PAGE_SIZE * 2 + 7;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        tier.set(`t${String(i)}`, i, { ttlMs: 60_000, tags: [tag('user')] }),
      ),
    );

    const result = await tier.invalidateTags([tag('user')]);

    expect(result.keys).toHaveLength(count);
    expect(client.members('x:e2:{user}')).toEqual([]);
  });

  /**
   * The bucket `x:e2:{post}` as a bust sees it when another client runs `between` after the bust's
   * FIRST read and before its second — the interleaving a page cursor has to survive.
   */
  const interleaved = (client: FakeRedis, between: () => Promise<unknown>): RedisLike => {
    let reads = 0;
    return {
      get: (key) => client.get(key),
      set: (key, value) => client.set(key, value),
      async send(command, args) {
        if (READS.has(command) && ++reads === 2) await between();
        return await client.send(command, args);
      },
    };
  };
  const READS = new Set(['ZSCAN']);
  const BUCKET = 'x:e2:{post}';
  const live = async (client: FakeRedis, member: string, score: number): Promise<void> => {
    await client.send('ZADD', [BUCKET, String(score), member]);
    await client.send('SET', [member, 'v', 'PX', '60000']);
  };

  test("a concurrent write's prune between two pages skips no live member", async () => {
    // A page of TIED dead members, then five live ones. The bust reads the dead page; a write's
    // prune removes it; a cursor that resumed at "that score, skip a page" stepped past the five
    // live keys, which then served stale until TTL.
    const client = fakeRedis();
    for (let i = 0; i < BUST_PAGE_SIZE; i += 1) {
      await client.send('ZADD', [BUCKET, '10', `x:c:d${String(i).padStart(4, '0')}`]);
    }
    for (let i = 0; i < 5; i += 1) await live(client, `x:c:l${i}`, 2_000 + i);

    const pruning = interleaved(client, () =>
      client.send('ZREMRANGEBYSCORE', [BUCKET, '-inf', '(100']),
    );
    const result = await tierFor(pruning).invalidateTags([tag('post')]);

    expect(result.keys.filter((key) => key.startsWith('l')).sort()).toEqual([
      'l0',
      'l1',
      'l2',
      'l3',
      'l4',
    ]);
  });

  test('a read member re-scored by a concurrent write between two pages skips no other', async () => {
    // A tie group wider than a page: one member already read is re-written (a fresh ZADD moves it
    // up). Under "that score, skip what was read" every later member shifts down one and the
    // first unread one was stepped over.
    const client = fakeRedis();
    const tied = BUST_PAGE_SIZE + 5;
    for (let i = 0; i < tied; i += 1) await live(client, `x:c:a${String(i).padStart(4, '0')}`, 100);

    const rescoring = interleaved(client, () =>
      client.send('ZADD', [BUCKET, '999999', 'x:c:a0000']),
    );
    const result = await tierFor(rescoring).invalidateTags([tag('post')]);

    expect(result.keys).toHaveLength(tied);
    expect(client.members(BUCKET)).toEqual([]);
  });
});
