// The tier's own behaviour: what it stores, what it reads back, what lease it spends and which
// namespace it spends it in. The tag -> keys bookkeeping is invisible from the outside — a bucket
// written wrong leaves keys no tag can ever reach again — so a fake Redis records every command
// and the wire traffic is the assertion. Its ORDERING guarantees are `redis-ordering.test.ts`'s
// subject, and what a Lua script actually does is `redis.live.test.ts`'s.

import { describe, expect, test } from 'bun:test';
import { appVersion, frozenClock } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import { createLruTier } from './lru';
import {
  createRedisTier,
  namespaceFor,
  REDIS_INVALIDATE_SCRIPT,
  REDIS_TAG_MEMBER_SCRIPT,
} from './redis';
import { fakeRedis, tierFor } from './redis-fake';
import { tag } from './tags';
import { createCacheStack } from './tiers';

describe('createRedisTier', () => {
  test('is named "redis"', () => {
    const tier = tierFor(fakeRedis());
    expect(tier.name).toBe('redis');
  });

  test('set then get round-trips the value', async () => {
    const tier = tierFor(fakeRedis());
    await tier.set('feed', { a: 1 });
    const entry = await tier.get<{ a: number }>('feed');
    expect(entry?.value).toEqual({ a: 1 });
  });

  test('get on a missing key resolves undefined', async () => {
    const tier = tierFor(fakeRedis());
    expect(await tier.get('missing')).toBeUndefined();
  });

  test('get on unparseable stored JSON resolves undefined, never throws', async () => {
    const client = fakeRedis();
    await client.set('x:c:badkey', 'not json');
    const tier = tierFor(client);
    await expect(tier.get('badkey')).resolves.toBeUndefined();
  });

  test('set with tags joins both the row bucket and the collection bucket', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('post-1', { title: 'hi' }, { tags: [tag('post', '1')] });

    const joins = client.sent.filter(
      (entry) => entry[0] === 'EVAL' && entry[1] === REDIS_TAG_MEMBER_SCRIPT,
    );
    expect(joins.map((entry) => [entry[3], entry[4]])).toEqual([
      ['x:t:{post}:1', 'x:c:post-1'],
      ['x:t:{post}', 'x:c:post-1'],
    ]);
  });

  test('set with an id-less tag joins only the collection bucket', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('users', ['u'], { tags: [tag('user')] });

    const joins = client.sent.filter(
      (entry) => entry[0] === 'EVAL' && entry[1] === REDIS_TAG_MEMBER_SCRIPT,
    );
    expect(joins.map((entry) => entry[3])).toEqual(['x:t:{user}']);
  });

  // The lease is spent in MILLISECONDS, exactly as the LRU tier holds it. `EX` with a `Math.ceil`
  // honoured a 1,001ms lease as 2s — favouring staleness, which is the opposite of what the jitter
  // machinery beside it protects, and it made two tiers of one stack disagree about when the same
  // entry dies. The tag buckets keep whole seconds: rounding a bucket's lease UP is correct,
  // because it has to outlive every member it holds.
  test('set spends the ttl in milliseconds, unrounded', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('k', 'v', { ttlMs: 500 });

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall).toEqual(['SET', 'x:c:k', JSON.stringify({ v: 'v', t: [] }), 'PX', '500']);
  });

  test('a sub-second remainder is not rounded up into staleness', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('k', 'v', { ttlMs: 1_001 });

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[4]).toBe('1001');
  });

  test('set with no ttlMs uses the default TTL (300_000ms -> PX 300000)', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('k', 'v');

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[3]).toBe('PX');
    expect(setCall?.[4]).toBe('300000');
  });

  test('a custom defaultTtlMs passed to createRedisTier is honoured', async () => {
    const client = fakeRedis();
    const tier = tierFor(client, { defaultTtlMs: 5_000 });
    await tier.set('k', 'v');

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[4]).toBe('5000');
  });

  test('del sends DEL for the value key only, not the tag buckets', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('k', 'v', { tags: [tag('post', '1')] });
    client.sent.length = 0;

    await tier.del('k');

    expect(client.sent).toEqual([['DEL', 'x:c:k']]);
  });

  test('invalidateTags([]) short-circuits without running the invalidation script', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);

    const result = await tier.invalidateTags([]);

    expect(result).toEqual({ tier: 'redis', keys: [] });
    expect(client.sent.some((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT)).toBe(false);
  });

  test('invalidateTags removes the value and returns the unprefixed key', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    // 'feed' joined both the row bucket (x:t:{post}:1) and the collection bucket (x:t:{post}) at
    // set time and the script walks every bucket it was handed, so a real server returns it twice
    // — `redis.live.test.ts` is where that is measured rather than stated.
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:feed', 'x:c:feed']);

    const result = await tier.invalidateTags([tag('post', '1')]);

    expect(result.tier).toBe('redis');
    // Deduped before it is deleted and reported, or the `/_x` panel overstates what cleared.
    expect(result.keys).toEqual(['feed']);
    expect(await tier.get('feed')).toBeUndefined();
  });

  test('the script declares every key it touches: value keys are deleted client-side', async () => {
    // A Lua script may only reach keys handed to it in KEYS. DELing a SMEMBERS result from
    // inside it is a cross-slot access — "attempted to access a non-local key in a cluster
    // node" on Redis Cluster and in Dragonfly's strict mode, swallowed into report.errors so a
    // failed bust read as partial and stale rows served until TTL.
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['x:c:feed']);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1')]);

    const evals = client.sent.filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT);
    expect(evals).toHaveLength(1);
    const [, script = '', numkeys = '0', ...keys] = evals[0] ?? [];
    // The script's own body must not delete anything but the tag buckets it was handed.
    expect(script).not.toContain("redis.call('DEL', key)");
    expect(keys).toHaveLength(Number(numkeys));
    // Every value key leaves as its own single-key DEL, which is always slot-local.
    const deletes = client.sent.filter((entry) => entry[0] === 'DEL');
    expect(deletes).toEqual([['DEL', 'x:c:feed']]);
  });

  test('invalidateTags drops a bucket an earlier tag already claimed', async () => {
    const client = fakeRedis();
    const tier = tierFor(client);
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, []);
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1'), tag('post')]);

    const evals = client.sent.filter((entry) => entry[1] === REDIS_INVALIDATE_SCRIPT);
    // buckets for tag('post','1') = [{post}:1, {post}]; tag('post') adds nothing new, so its
    // call is not issued at all rather than sent with an empty KEYS.
    expect(evals).toHaveLength(1);
    expect(evals[0]?.[2]).toBe('2');
  });

  test('get reports the remaining lease as expiresAt, read from PTTL', async () => {
    const client = fakeRedis();
    const tier = tierFor(client, { clock: frozenClock(10_000) });
    await tier.set('k', 'v', { ttlMs: 5_000 });

    expect((await tier.get('k'))?.expiresAt).toBe(15_000);
    // Asked alongside the GET, on the value key — never on the tag buckets.
    expect(client.sent.filter((entry) => entry[0] === 'PTTL')).toEqual([['PTTL', 'x:c:k']]);
  });

  test('a stored key with no expiry reports no expiresAt', async () => {
    // PTTL answers -1 for a key that exists without a lease (one written outside this tier);
    // `-1` is a sentinel, not one millisecond ago, so the entry must report no expiry at all.
    const client = fakeRedis();
    await client.set('x:c:leaseless', JSON.stringify({ v: 'v', t: [] }));
    const tier = tierFor(client, { clock: frozenClock(10_000) });

    const entry = await tier.get('leaseless');
    expect(entry?.value).toBe('v');
    expect(entry?.expiresAt).toBeUndefined();
  });

  test('promotion out of redis carries the REMAINING lease into the LRU, not the caller ttl', async () => {
    // The cross-tier expiry contract, end to end: without `expiresAt` on the redis hit the stack
    // can only promote on `setOptions.ttlMs`, so a row one second from expiry gets a fresh five
    // minutes in the LRU on every read and the closer tier outlives the entry it copied.
    const client = fakeRedis();
    const clock = frozenClock(10_000);
    const lru = createLruTier({ clock, rng: () => 0 });
    const stack = createCacheStack([lru, tierFor(client, { clock })], { clock });
    await tierFor(client, { clock }).set('k', 'v', { ttlMs: 5_000 });

    expect(await stack.read('k', () => Promise.resolve('loaded'), { ttlMs: 300_000 })).toBe('v');
    expect(lru.cache.get('k')?.expiresAt).toBe(15_000);
  });

  test('constructing with no client and no Bun.redis throws CacheDriverUnavailableError lazily', async () => {
    // This sandbox has a real Bun.redis (a redis answers on the default port), so
    // `resolveClient` would otherwise never reach its throwing branch. Stub the global to
    // simulate "not configured" rather than skip the case — restore it unconditionally so no
    // other test in this process (or file) observes the stub.
    const bunWithRedis = Bun as unknown as { redis?: unknown };
    const original = bunWithRedis.redis;
    bunWithRedis.redis = undefined;
    try {
      const tier = createRedisTier();
      await expect(tier.get('k')).rejects.toThrow(CacheDriverUnavailableError);
    } finally {
      bunWithRedis.redis = original;
    }
  });
});

describe('the shared tier is namespaced per build', () => {
  test('the default namespace carries appVersion(), so two builds cannot read each other', async () => {
    // Rename a field and deploy: old and new pods share one Redis, `JSON.parse` does not
    // validate, and the old pod hands the new shape to a renderer expecting the old one.
    const client = fakeRedis();
    const tier = createRedisTier({ client, rng: () => 0 });
    await tier.set('feed', ['a'], { tags: [tag('post')] });

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[1]).toBe(`x:${appVersion()}:c:feed`);
  });

  test('an explicit buildId is used verbatim, and two of them never collide', async () => {
    const one = fakeRedis();
    const two = fakeRedis();
    await createRedisTier({ client: one, buildId: 'v1', rng: () => 0 }).set('feed', ['a']);
    await createRedisTier({ client: two, buildId: 'v2', rng: () => 0 }).set('feed', ['b']);

    expect(one.sent.find((entry) => entry[0] === 'SET')?.[1]).toBe('x:v1:c:feed');
    expect(two.sent.find((entry) => entry[0] === 'SET')?.[1]).toBe('x:v2:c:feed');
  });

  test('buildId: null is the opt-out, for a team that versions its own payloads', () => {
    expect(namespaceFor('x', null)).toBe('x');
    expect(namespaceFor('x', '')).toBe('x');
    expect(namespaceFor('app', 'abc123')).toBe('app:abc123');
    expect(namespaceFor('x', undefined)).toBe(`x:${appVersion()}`);
  });

  test('invalidateTags strips the whole namespace, not just the prefix', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client, buildId: 'v1', prefix: 'app', rng: () => 0 });
    await tier.set('feed', ['a'], { tags: [tag('post')] });
    client.answerEval(REDIS_INVALIDATE_SCRIPT, ['app:v1:c:feed']);

    expect((await tier.invalidateTags([tag('post')])).keys).toEqual(['feed']);
  });
});

describe('the redis lease is spread', () => {
  test('the default jitter shortens PX, and rng() === 0 is the full lease', async () => {
    const full = fakeRedis();
    const shaved = fakeRedis();
    await createRedisTier({ client: full, buildId: null, rng: () => 0 }).set('k', 'v');
    await createRedisTier({ client: shaved, buildId: null, rng: () => 1 }).set('k', 'v');

    expect(full.sent.find((entry) => entry[0] === 'SET')?.[4]).toBe('300000');
    // 5% of 300s, in the milliseconds the spread was computed in — a whole-second `EX` could not
    // have carried a shave finer than a second, which is the other half of the rounding defect.
    expect(shaved.sent.find((entry) => entry[0] === 'SET')?.[4]).toBe('285000');
  });

  test('jitterFraction: 0 turns it off', async () => {
    const client = fakeRedis();
    await createRedisTier({ client, buildId: null, jitterFraction: 0, rng: () => 1 }).set('k', 'v');
    expect(client.sent.find((entry) => entry[0] === 'SET')?.[4]).toBe('300000');
  });
});
