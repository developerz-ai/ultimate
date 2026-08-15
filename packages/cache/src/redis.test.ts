// The tag -> keys bookkeeping is what buys the one-`EVAL` invalidation instead of a `KEYS` scan,
// and it is invisible from the outside: a bucket written wrong leaves keys that no tag can ever
// reach again. A fake Redis records every command so the wire traffic itself is the assertion.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import { createLruTier } from './lru';
import type { RedisLike } from './redis';
import { createRedisTier } from './redis';
import { tag } from './tags';
import { createCacheStack } from './tiers';

function fakeRedis(): RedisLike & { readonly sent: string[][] } {
  const sets = new Map<string, Set<string>>();
  const values = new Map<string, string>();
  // The lease `EX` bought, in ms. A fake that answered no `PTTL` could not catch a tier that
  // stopped asking for one — and a hit read back without its remaining life is promoted on the
  // caller's ttl, which is how a value one second from expiry gets a fresh five minutes.
  const expiries = new Map<string, number>();
  const sent: string[][] = [];
  return {
    sent,
    get(key) {
      return Promise.resolve(values.get(key) ?? null);
    },
    set(key, value) {
      values.set(key, value);
      return Promise.resolve('OK');
    },
    send(command, args) {
      sent.push([command, ...args]);
      if (command === 'SET') {
        values.set(String(args[0]), String(args[1]));
        if (args[2] === 'EX') expiries.set(String(args[0]), Number(args[3]) * 1_000);
        return Promise.resolve('OK');
      }
      if (command === 'PTTL') {
        const key = String(args[0]);
        if (!values.has(key)) return Promise.resolve(-2);
        return Promise.resolve(expiries.get(key) ?? -1);
      }
      if (command === 'SADD') {
        const bucket = String(args[0]);
        const existing = sets.get(bucket) ?? new Set<string>();
        existing.add(String(args[1]));
        sets.set(bucket, existing);
        return Promise.resolve(1);
      }
      if (command === 'DEL') {
        values.delete(String(args[0]));
        expiries.delete(String(args[0]));
        return Promise.resolve(1);
      }
      if (command === 'EVAL') {
        // Mirrors INVALIDATE_SCRIPT exactly, and the mirroring is the point: the script reads
        // the members and drops the TAG SETS ONLY. It must not delete a value key — a script may
        // only touch what it was handed in KEYS, and a fake that deleted them anyway would hide
        // a tier that stopped issuing its own DELs.
        const count = Number(args[1]);
        const buckets = args.slice(2, 2 + count);
        const removed: string[] = [];
        for (const bucket of buckets) {
          for (const member of sets.get(bucket) ?? []) removed.push(member);
          sets.delete(bucket);
        }
        return Promise.resolve(removed);
      }
      return Promise.resolve(null);
    },
  };
}

describe('createRedisTier', () => {
  test('is named "redis"', () => {
    const tier = createRedisTier({ client: fakeRedis() });
    expect(tier.name).toBe('redis');
  });

  test('set then get round-trips the value', async () => {
    const tier = createRedisTier({ client: fakeRedis() });
    await tier.set('feed', { a: 1 });
    const entry = await tier.get<{ a: number }>('feed');
    expect(entry?.value).toEqual({ a: 1 });
  });

  test('get on a missing key resolves undefined', async () => {
    const tier = createRedisTier({ client: fakeRedis() });
    expect(await tier.get('missing')).toBeUndefined();
  });

  test('get on unparseable stored JSON resolves undefined, never throws', async () => {
    const client = fakeRedis();
    await client.set('x:c:badkey', 'not json');
    const tier = createRedisTier({ client });
    await expect(tier.get('badkey')).resolves.toBeUndefined();
  });

  test('set with tags SADDs into both the row bucket and the collection bucket', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('post-1', { title: 'hi' }, { tags: [tag('post', '1')] });

    const saddCalls = client.sent.filter((entry) => entry[0] === 'SADD');
    expect(saddCalls).toEqual(
      expect.arrayContaining([
        ['SADD', 'x:t:post:1', 'x:c:post-1'],
        ['SADD', 'x:t:post', 'x:c:post-1'],
      ]),
    );
    expect(saddCalls).toHaveLength(2);
  });

  test('set with an id-less tag SADDs only the collection bucket', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('users', ['u'], { tags: [tag('user')] });

    const saddCalls = client.sent.filter((entry) => entry[0] === 'SADD');
    expect(saddCalls).toEqual([['SADD', 'x:t:user', 'x:c:users']]);
  });

  test('set with a custom ttlMs rounds up to whole seconds, minimum 1', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('k', 'v', { ttlMs: 500 });

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall).toEqual(['SET', 'x:c:k', JSON.stringify({ v: 'v', t: [] }), 'EX', '1']);
  });

  test('set with no ttlMs uses the default TTL (300_000ms -> EX 300)', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('k', 'v');

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[3]).toBe('EX');
    expect(setCall?.[4]).toBe('300');
  });

  test('a custom defaultTtlMs passed to createRedisTier is honoured', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client, defaultTtlMs: 5_000 });
    await tier.set('k', 'v');

    const setCall = client.sent.find((entry) => entry[0] === 'SET');
    expect(setCall?.[4]).toBe('5');
  });

  test('del sends DEL for the value key only, not the tag buckets', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('k', 'v', { tags: [tag('post', '1')] });
    client.sent.length = 0;

    await tier.del('k');

    expect(client.sent).toEqual([['DEL', 'x:c:k']]);
  });

  test('invalidateTags([]) short-circuits without calling EVAL', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });

    const result = await tier.invalidateTags([]);

    expect(result).toEqual({ tier: 'redis', keys: [] });
    expect(client.sent.some((entry) => entry[0] === 'EVAL')).toBe(false);
  });

  test('invalidateTags removes the value and returns the unprefixed key', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });

    const result = await tier.invalidateTags([tag('post', '1')]);

    expect(result.tier).toBe('redis');
    // 'feed' was SADD'd into both the row bucket (x:t:post:1) and the collection bucket
    // (x:t:post) at set time and the script walks every bucket, so it comes back twice — deduped
    // before it is deleted and reported, or the `/_x` panel overstates what cleared.
    expect(result.keys).toEqual(['feed']);
    expect(await tier.get('feed')).toBeUndefined();
  });

  test('the script declares every key it touches: value keys are deleted client-side', async () => {
    // A Lua script may only reach keys handed to it in KEYS. DELing a SMEMBERS result from
    // inside it is a cross-slot access — "attempted to access a non-local key in a cluster
    // node" on Redis Cluster and in Dragonfly's strict mode, swallowed into report.errors so a
    // failed bust read as partial and stale rows served until TTL.
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });
    client.sent.length = 0;

    await tier.invalidateTags([tag('post', '1')]);

    const evals = client.sent.filter((entry) => entry[0] === 'EVAL');
    expect(evals).toHaveLength(1);
    const [, script = '', numkeys = '0', ...keys] = evals[0] ?? [];
    // The script's own body must not delete anything but the tag buckets it was handed.
    expect(script).not.toContain("redis.call('DEL', key)");
    expect(keys).toHaveLength(Number(numkeys));
    // Every value key leaves as its own single-key DEL, which is always slot-local.
    const deletes = client.sent.filter((entry) => entry[0] === 'DEL');
    expect(deletes).toEqual([['DEL', 'x:c:feed']]);
  });

  test('invalidateTags dedupes overlapping buckets across tags', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client });
    await tier.set('feed', ['a'], { tags: [tag('post', '1')] });

    await tier.invalidateTags([tag('post', '1'), tag('post')]);

    const evalCall = client.sent.find((entry) => entry[0] === 'EVAL');
    expect(evalCall).toBeDefined();
    // buckets for tag('post','1') = [x:t:post:1, x:t:post]; buckets for tag('post') = [x:t:post].
    // Deduped, that's 2 buckets, not 3.
    expect(evalCall?.[2]).toBe('2');
  });

  test('get reports the remaining lease as expiresAt, read from PTTL', async () => {
    const client = fakeRedis();
    const tier = createRedisTier({ client, clock: frozenClock(10_000) });
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
    const tier = createRedisTier({ client, clock: frozenClock(10_000) });

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
    const lru = createLruTier({ clock });
    const stack = createCacheStack([lru, createRedisTier({ client, clock })], { clock });
    await createRedisTier({ client, clock }).set('k', 'v', { ttlMs: 5_000 });

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
