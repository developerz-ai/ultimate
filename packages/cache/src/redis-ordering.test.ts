// The shared tier's ORDERING guarantees, which are only visible on the wire: which command goes
// out before which, which keys travel together, which slot they hash to, and which lease each
// join asks for. Every failure pinned here is one a report of `errors: []` cannot see — the tier
// answers correctly to its caller and leaves the store in a state no later bust can repair.
// The fake is a recorder (`redis-fake.ts`); what a script DOES is `redis.live.test.ts`'s subject.

import { describe, expect, test } from 'bun:test';
import type { RedisLike } from './redis';
import { REDIS_INVALIDATE_SCRIPT, REDIS_TAG_MEMBER_SCRIPT } from './redis';
import { fakeRedis, keysOf, slotTokenOf, tierFor } from './redis-fake';
import { tag } from './tags';

// Both halves of the shared tier's write and both halves of its bust are ORDERED, and the order
// is only visible on the wire. Each test here pins one interleaving that a report of `errors: []`
// cannot see.
describe('a bust racing a write, on the wire', () => {
  test('the tag buckets are joined BEFORE the value key is written', async () => {
    // SET first leaves a window where a bust finds an empty bucket: the value it should have
    // cleared is invisible to the bust and serves its own pre-invalidation payload for the full
    // TTL. Joining first moves the window somewhere the re-check below can see it.
    const client = fakeRedis();
    await tierFor(client).set('feed', 'v', { ttlMs: 60_000, tags: [tag('post', '1')] });

    const wire = client.sent.map((entry) => (entry[0] === 'EVAL' ? 'JOIN' : entry[0]));
    expect(wire.indexOf('SET')).toBeGreaterThan(wire.lastIndexOf('JOIN'));
  });

  test('a bust that landed mid-write takes the value with it, rather than orphaning it', async () => {
    // The membership is the signal: `invalidateTags` only removes a member whose value key it
    // deleted, so a member gone by the time the SET lands means this write was busted while it
    // was in the air. Keeping it would serve a row nothing can reach by tag ever again.
    const sent: string[][] = [];
    const client: RedisLike = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
      send(command, args) {
        sent.push([command, ...args]);
        // 0 = "not a member": the bust ran between the join and the write.
        return Promise.resolve(command === 'SISMEMBER' ? 0 : 1);
      },
    };

    await tierFor(client).set('feed', 'v', { ttlMs: 60_000, tags: [tag('post', '1')] });

    expect(sent.filter((entry) => entry[0] === 'DEL')).toEqual([['DEL', 'x:c:feed']]);
  });

  test('a write nothing raced is not deleted by its own re-check', async () => {
    // The mutation this catches: a re-check that reads any reply as "gone" deletes every value
    // the tier writes, which is a cache that never caches.
    const client = fakeRedis();
    await tierFor(client).set('feed', 'v', { ttlMs: 60_000, tags: [tag('post', '1')] });

    expect(client.sent.filter((entry) => entry[0] === 'DEL')).toEqual([]);
    expect((await tierFor(client).get('feed'))?.value).toBe('v');
  });

  test('a member whose DEL failed stays in its bucket, so a retry still reaches it', async () => {
    // The bust used to drop the bucket atomically with the SMEMBERS that read it, so a failure in
    // the client-side DEL batch orphaned every surviving member permanently: the retry the error
    // asks for returns `keys: []` and those rows live out their TTL untouched.
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('gone', 'a', { ttlMs: 60_000, tags: [tag('post', '1')] });
    await tier.set('stuck', 'b', { ttlMs: 60_000, tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:gone', 'x:c:stuck']);
    client.refuseDel('x:c:stuck');
    client.sent.length = 0;

    await expect(tier.invalidateTags([tag('post', '1')])).rejects.toThrow('redis refused DEL');

    const removed = client.sent
      .filter((entry) => entry[0] === 'SREM')
      .map((entry) => entry.slice(2));
    // Only what actually died leaves the bucket. `x:c:stuck` is still a member, still tagged,
    // and the retry the error asks for — `invalidateTags([tag('post', '1')])` — reaches it.
    // Three buckets: the row's, the collection's, and the entity index the row bust never reads.
    expect(removed).toEqual([['x:c:gone'], ['x:c:gone'], ['x:c:gone']]);
  });

  test('a bust that succeeded empties the buckets it read, member by member', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', 'a', { ttlMs: 60_000, tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:feed']);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1')]);

    expect(client.sent.filter((entry) => entry[0] === 'SREM')).toEqual([
      ['SREM', 'x:t:{post}:1', 'x:c:feed'],
      ['SREM', 'x:t:{post}', 'x:c:feed'],
      ['SREM', 'x:e:{post}', 'x:c:feed'],
    ]);
  });

  test('a ROW bust leaves the entity index, which it never reads, with no corpse in it', async () => {
    // Asymmetric on purpose. READING `x:e:{post}` for a row bust returns every post-tagged key
    // in the store and would delete them all — the over-reach the second bucket exists to stop.
    // SREMing from it cannot over-reach: only the members this bust actually deleted leave. Left
    // alone, the deleted value key kept its membership there for ever while `TAG_MEMBER_SCRIPT`
    // renewed the index's lease on every write — the unbounded `SMEMBERS` the lease was added to
    // prevent, rebuilt out of dead keys.
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', 'a', { ttlMs: 60_000, tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:feed']);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1')]);

    const read = client.sent.filter((entry) => entry[0] === 'EVAL').flatMap(keysOf);
    expect(read).not.toContain('x:e:{post}');
    const swept = client.sent.filter((entry) => entry[0] === 'SREM').map((entry) => entry[1]);
    expect(swept).toContain('x:e:{post}');
  });

  test('a key that expires between GET and PTTL is a miss, not a full-lease promotion', async () => {
    // Two commands, one key: it can die between them. The value comes back, PTTL answers -2 (no
    // such key), and an entry with no `expiresAt` is promoted into the LRU on the CALLER's ttl —
    // a row that was one millisecond from death gets a fresh five minutes, one tier closer.
    const client: RedisLike = {
      get: () => Promise.resolve(JSON.stringify({ v: 'reaped', t: [] })),
      set: () => Promise.resolve('OK'),
      send: (command) => Promise.resolve(command === 'PTTL' ? -2 : 1),
    };

    expect(await tierFor(client).get('feed')).toBeUndefined();
  });
});

describe('invalidation is slot-local on Redis Cluster', () => {
  test('no single command is ever handed keys from two different tags', async () => {
    // The failure this pins: one EVAL carrying every tag-set key is rejected with CROSSSLOT
    // before the script runs, because `x:t:post` and `x:t:user` hash to different slots. It
    // lands in report.errors as a partial bust, and stale rows serve until TTL.
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    await tier.set('inbox', ['b'], { tags: [tag('user', '9')] });
    await tier.set('teams', ['c'], { tags: [tag('team')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1'), tag('user', '9'), tag('team')]);

    for (const command of client.sent) {
      const slots = new Set(keysOf(command).map(slotTokenOf));
      expect(slots.size).toBeLessThanOrEqual(1);
    }
    // One script call per tag, not one for the batch.
    expect(client.sent.filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT)).toHaveLength(3);
  });

  test("a row tag's two buckets share one slot, so they may travel in one call", async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1')]);

    const evals = client.sent.filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT);
    expect(keysOf(evals[0] ?? [])).toEqual(['x:t:{post}:1', 'x:t:{post}']);
    expect(new Set(keysOf(evals[0] ?? []).map(slotTokenOf))).toEqual(new Set(['post']));
  });

  test('every tag-set key carries a hash tag; value keys never need one', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1'), tag('user')] });

    const buckets = client.sent
      .filter((entry) => entry[1] === REDIS_TAG_MEMBER_SCRIPT)
      .map((entry) => String(entry[3]));
    expect(buckets).toEqual(['x:t:{post}:1', 'x:e:{post}', 'x:t:{user}', 'x:e:{user}']);
    for (const bucket of buckets) expect(bucket).toMatch(/\{[^}]+\}/);
  });
});

// The lease a join ASKS for is wire traffic and belongs here. Whether the server then grants it,
// keeps the longer of two, and gives a fresh bucket one at all is `TAG_MEMBER_SCRIPT`'s own
// semantics — three claims a fake can only restate, so they live in `redis.live.test.ts`.
describe('tag sets are bounded', () => {
  test('every join asks for a lease longer than the member it added', async () => {
    // Without this a tag set grows forever: value keys expire after five minutes, their
    // membership never does, and one publish becomes a multi-million-member SMEMBERS.
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { ttlMs: 60_000, tags: [tag('post', '1')] });

    const joins = client.sent.filter((entry) => entry[1] === REDIS_TAG_MEMBER_SCRIPT);
    expect(joins).toHaveLength(2);
    for (const join of joins) {
      // 60s member + the 60s grace: the bucket must outlive what it points at.
      expect(Number(join[5])).toBe(120);
    }
  });
});
