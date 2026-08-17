// The tag -> keys bookkeeping is what buys the scripted invalidation instead of a `KEYS` scan,
// and it is invisible from the outside: a bucket written wrong leaves keys that no tag can ever
// reach again. A fake Redis records every command, so the wire traffic itself is the assertion:
// which keys travel together, which slot they hash to, which lease each join asks for. What a
// fake cannot do is run a Lua script — so it no longer pretends to, and every claim about what
// the two scripts DO lives in `redis.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import { appVersion, frozenClock } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import { createLruTier } from './lru';
import type { RedisLike, RedisTierOptions } from './redis';
import {
  createRedisTier,
  namespaceFor,
  REDIS_INVALIDATE_SCRIPT,
  REDIS_TAG_MEMBER_SCRIPT,
} from './redis';
import { tag } from './tags';
import { createCacheStack } from './tiers';

interface FakeRedis extends RedisLike {
  readonly sent: string[][];
  /**
   * What the server's script answers for one `EVAL`. A test driving a path that READS the reply
   * has to say what came back; there is no default, because `[]` is exactly what a gutted
   * `INVALIDATE_SCRIPT` returns and a silent one would make "the bust cleared nothing" the
   * baseline of this whole file.
   */
  answerEval(script: string, reply: unknown): void;
}

function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  // The lease `EX` bought, in ms. A fake that answered no `PTTL` could not catch a tier that
  // stopped asking for one — and a hit read back without its remaining life is promoted on the
  // caller's ttl, which is how a value one second from expiry gets a fresh five minutes.
  const expiries = new Map<string, number>();
  const sent: string[][] = [];
  // A fake cannot run Lua. This one used to mirror both script bodies in TypeScript, which is why
  // gutting either to `return 1` / `return {}` left all 517 tests in `cache` + `query` green — the
  // assertions ran against the mirror and the script itself was executed by nothing, ever. What is
  // left is a recorder: the wire traffic is this file's subject, the script body is opaque to it,
  // and every claim about what a script DOES lives in `redis.live.test.ts` behind TEST_REDIS_URL.
  const evalReplies = new Map<string, unknown>([
    // Nothing reads the tag-join's reply, so a constant here asserts nothing about the script.
    [REDIS_TAG_MEMBER_SCRIPT, 1],
  ]);
  return {
    sent,
    answerEval(script, reply) {
      evalReplies.set(script, reply);
    },
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
        if (args[2] === 'PX') expiries.set(String(args[0]), Number(args[3]));
        return Promise.resolve('OK');
      }
      if (command === 'PTTL') {
        const key = String(args[0]);
        if (!values.has(key)) return Promise.resolve(-2);
        return Promise.resolve(expiries.get(key) ?? -1);
      }
      if (command === 'DEL') {
        values.delete(String(args[0]));
        expiries.delete(String(args[0]));
        return Promise.resolve(1);
      }
      if (command === 'EVAL') {
        const script = String(args[0]);
        if (!evalReplies.has(script)) {
          // Loud rather than `[]`: an empty member list is what the gutted script answers, so a
          // default would report every bust in this file as clean and every one of them as green.
          throw new Error(
            'fake redis cannot execute EVAL — call answerEval(script, reply) to state what the ' +
              'server returned, or move the claim to redis.live.test.ts, which runs the script',
          );
        }
        return Promise.resolve(evalReplies.get(script));
      }
      return Promise.resolve(null);
    },
  };
}

/**
 * `buildId: null` and `rng: () => 0` are the two things a wire assertion needs pinned: the
 * namespace carries the build id by default, and the lease is spread by default.
 */
function tierFor(client: RedisLike, extra: RedisTierOptions = {}) {
  return createRedisTier({ client, buildId: null, rng: () => 0, ...extra });
}

/** The `{...}` hash tag of a key, which is what Redis Cluster hashes to a slot. */
function slotTokenOf(key: string): string {
  return /\{([^}]*)\}/.exec(key)?.[1] ?? key;
}

/** Every key argument of one command — `EVAL script numkeys k1 .. kN` and `DEL key`. */
function keysOf(command: readonly string[]): string[] {
  if (command[0] === 'EVAL') return command.slice(3, 3 + Number(command[2]));
  if (command[0] === 'DEL') return command.slice(1);
  return [];
}

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
    expect(buckets).toEqual(['x:t:{post}:1', 'x:t:{post}', 'x:t:{user}']);
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
