// The only proof the lease script is Lua, and that the sorted-set commands the fake holds as state
// mean the same on a real server — RESP3's `WITHSCORES` shape, `(` bounds, the prune. Every other
// test hands `EVAL` to a fake that cannot run a script, so its body is inert text there. A real
// server is the only thing that has an opinion about a script.
//
// Skips unless a Redis is configured. Locally:
//
//   docker run -d --name x-redis -p 6379:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://localhost:6379 bun test packages/cache/src/redis.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import type { CacheTierFailureEvent } from '@ultimat3/core';
import { frozenClock, subscribe, systemClock } from '@ultimat3/core';
import { redisClient } from '@ultimat3/core/redis';
import { lruTier } from './lru';
import type { RedisLike } from './redis';
import { redisTier } from './redis';
import { BUST_PAGE_SIZE, TAG_GRACE_MS } from './redis-buckets';
import { tag } from './tags';
import type { CacheTier } from './tiers';
import { cacheStack, nowMs } from './tiers';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;

/**
 * One namespace per run: a shared server survives two runs at once, and a run that died. Not
 * `process.pid` — a Node compatibility global, and one two containers against one Redis can hand
 * out twice. `crypto.randomUUID` is a web standard Bun implements, so nothing here is `node:`.
 */
const PREFIX = `xlive-${crypto.randomUUID()}`;

type LiveClient = RedisLike & { close(): void };

/** Every reply this file reads is a number or a list, so the `any` off `send` stops here. */
const reply = async (client: LiveClient, command: string, args: string[]): Promise<unknown> =>
  (await client.send(command, args)) as unknown;

const count = async (client: LiveClient, command: string, key: string): Promise<number> =>
  Number(await reply(client, command, [key]));

describe.skipIf(!hasRedis)(
  'live · redis · the buckets and the lease script, on a real server',
  () => {
    const opened: LiveClient[] = [];

    const raw = (): LiveClient => {
      const client: LiveClient = new Bun.RedisClient(url ?? '');
      opened.push(client);
      return client;
    };

    const tierOn = (client: RedisLike) =>
      redisTier({ client, prefix: PREFIX, buildId: null, rng: () => 0 });

    afterAll(async () => {
      // `KEYS` is what this package refuses to ship as an invalidation path; over a namespace this
      // process owns, in a teardown, it is the cheapest way to leave the server as we found it.
      const client = raw();
      const found = await reply(client, 'KEYS', [`${PREFIX}:*`]);
      for (const key of Array.isArray(found) ? found : [])
        await reply(client, 'DEL', [String(key)]);
      for (const created of opened) created.close();
    });

    test('set → tag join → invalidateTags → miss, end to end', async () => {
      const tier = tierOn(raw());
      await tier.set('feed', { n: 1 }, { ttlMs: 60_000, tags: [tag('post', '1')] });

      expect((await tier.get<{ n: number }>('feed'))?.value).toEqual({ n: 1 });

      const result = await tier.invalidateTags([tag('post', '1')]);

      expect(result.keys).toEqual(['feed']);
      expect(await tier.get('feed')).toBeUndefined();
    });

    test("a member is scored past its value key's expiry, by the grace", async () => {
      const client = raw();
      const tier = tierOn(client);
      const before = nowMs(systemClock);
      await tier.set('scored', 'v', { ttlMs: 60_000, tags: [tag('scored', '1')] });

      const score = Number(
        await reply(client, 'ZSCORE', [`${PREFIX}:t2:{scored}:1`, `${PREFIX}:c:scored`]),
      );
      expect(score).toBeGreaterThanOrEqual(before + 60_000 + TAG_GRACE_MS);
      expect(score).toBeLessThanOrEqual(nowMs(systemClock) + 60_000 + TAG_GRACE_MS);
    });

    test('a write prunes every member already past its score: the bucket holds live keys only', async () => {
      // Without the prune an entity written constantly and never invalidated collected every key it
      // ever wrote, and its first bust read millions in one reply.
      const client = raw();
      const past = redisTier({
        client,
        prefix: PREFIX,
        buildId: null,
        rng: () => 0,
        clock: frozenClock(nowMs(systemClock) - 3_600_000),
      });
      for (let i = 0; i < 50; i += 1) {
        await past.set(`stale-${String(i)}`, i, { ttlMs: 1_000, tags: [tag('pruned')] });
      }
      expect(await count(client, 'ZCARD', `${PREFIX}:e2:{pruned}`)).toBe(50);

      await tierOn(client).set('live', 'v', { ttlMs: 60_000, tags: [tag('pruned')] });

      expect(await count(client, 'ZCARD', `${PREFIX}:t2:{pruned}`)).toBe(1);
      expect(await count(client, 'ZCARD', `${PREFIX}:e2:{pruned}`)).toBe(1);
    });

    test('a bust of a bucket wider than a page reads every page and clears every key', async () => {
      // The real `WITHSCORES` reply (RESP3 pairs through Bun's client) is what the cursor parses.
      const client = raw();
      const tier = tierOn(client);
      const total = BUST_PAGE_SIZE * 2 + 3;
      await Promise.all(
        Array.from({ length: total }, (_, i) =>
          tier.set(`paged-${String(i)}`, i, { ttlMs: 60_000, tags: [tag('paged')] }),
        ),
      );

      expect((await tier.invalidateTags([tag('paged')])).keys).toHaveLength(total);
      expect(await count(client, 'EXISTS', `${PREFIX}:e2:{paged}`)).toBe(0);
      expect(await count(client, 'EXISTS', `${PREFIX}:c:paged-0`)).toBe(0);
    });

    test('a prune and a re-score landing between two scan pages skip no live key', async () => {
      // The two interleavings that broke a `(score, offset)` cursor, against the server's own
      // `ZSCAN`: a page of tied dead members pruned away, and a read tie member re-scored up.
      const client = raw();
      const bucket = `${PREFIX}:e2:{scanned}`;
      const dead = Array.from({ length: BUST_PAGE_SIZE }, (_, i) => [
        '10',
        `${PREFIX}:c:dead-${i}`,
      ]);
      await reply(client, 'ZADD', [bucket, ...dead.flat()]);
      const live = Array.from({ length: BUST_PAGE_SIZE + 5 }, (_, i) => `${PREFIX}:c:live-${i}`);
      await reply(client, 'ZADD', [bucket, ...live.flatMap((member) => ['5000', member])]);
      for (const member of live) await reply(client, 'SET', [member, 'v', 'PX', '60000']);
      let reads = 0;
      const racing: RedisLike = {
        get: (key) => client.get(key),
        set: (key, value) => client.set(key, value),
        async send(command: string, args: string[]): Promise<unknown> {
          if (command === 'ZSCAN' && ++reads === 2) {
            await reply(client, 'ZREMRANGEBYSCORE', [bucket, '-inf', '(100']);
            await reply(client, 'ZADD', [bucket, '999999', live[0] ?? '']);
          }
          return await client.send(command, args);
        },
      };

      const result = await tierOn(racing).invalidateTags([tag('scanned')]);

      expect(reads).toBeGreaterThan(1);
      expect(result.keys.filter((key) => key.startsWith('live-'))).toHaveLength(live.length);
    });

    test('the TIER empties the bucket, one ZREM of what it actually deleted', async () => {
      const client = raw();
      const tier = tierOn(client);
      await tier.set('swept', 'v', { ttlMs: 60_000, tags: [tag('swept', '11')] });
      const bucket = `${PREFIX}:t2:{swept}:11`;
      expect(await count(client, 'ZCARD', bucket)).toBe(1);

      expect((await tier.invalidateTags([tag('swept', '11')])).keys).toEqual(['swept']);

      // An emptied sorted set is a key Redis removes — reached by a path where a failure leaves the
      // membership behind instead of orphaning it.
      expect(await count(client, 'EXISTS', bucket)).toBe(0);
      expect(await count(client, 'EXISTS', `${PREFIX}:c:swept`)).toBe(0);
      // The entity index too, which a ROW bust deliberately never READS: `set` joined it, so a
      // membership left behind here is a corpse in a set every later write renews the lease on.
      expect(await count(client, 'EXISTS', `${PREFIX}:e2:{swept}`)).toBe(0);
    });

    test('a bust landing between the join and the write leaves no unreachable row', async () => {
      // The real interleaving, driven by a client that busts the tag as the `SET` goes out: the
      // bucket already holds this key's membership, the value key does not exist yet, so the bust
      // removes the membership and deletes nothing. Without the re-check the `SET` that follows
      // publishes a row no bust of `raced` can ever reach again.
      const client = raw();
      const buster = tierOn(raw());
      let busted = false;
      const racing: RedisLike = {
        get: (key) => client.get(key),
        set: (key, value) => client.set(key, value),
        async send(command: string, args: string[]): Promise<unknown> {
          if (command === 'SET' && !busted) {
            busted = true;
            await buster.invalidateTags([tag('raced')]);
          }
          return await client.send(command, args);
        },
      };
      const tier = redisTier({ client: racing, prefix: PREFIX, buildId: null, rng: () => 0 });

      await tier.set('raced', 'v', { ttlMs: 60_000, tags: [tag('raced')] });

      expect(busted).toBe(true);
      expect(await tier.get('raced')).toBeUndefined();
    });

    test('a fresh bucket comes out of the join with a lease, never immortal', async () => {
      const client = raw();
      const tier = tierOn(client);
      await tier.set('fresh', 'v', { ttlMs: 60_000, tags: [tag('freshly')] });

      // 60s member + the 60s grace. `-1` is a bucket that outlives an entity nobody writes any
      // more (what `EXPIRE … GT` alone leaves behind); `-2` is a bucket the `ZADD` never created.
      const ttl = await count(client, 'TTL', `${PREFIX}:t2:{freshly}`);
      expect(ttl).toBeGreaterThan(60);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    test('a short-lived member cannot shorten the bucket a long-lived one is in', async () => {
      const client = raw();
      const tier = tierOn(client);
      const bucket = `${PREFIX}:t2:{shortened}`;
      await tier.set('long', 'v', { ttlMs: 3_600_000, tags: [tag('shortened')] });
      await tier.set('short', 'v', { ttlMs: 60_000, tags: [tag('shortened')] });

      // Shortened, `long` is unreachable by tag and serves stale until its own lease runs out.
      expect(await count(client, 'TTL', bucket)).toBeGreaterThan(3_000);
      expect(await count(client, 'ZCARD', bucket)).toBe(2);
    });

    test('a longer member raises the lease: the bucket must outlive what it points at', async () => {
      const client = raw();
      const tier = tierOn(client);
      const bucket = `${PREFIX}:t2:{raised}`;
      await tier.set('short', 'v', { ttlMs: 60_000, tags: [tag('raised')] });
      await tier.set('long', 'v', { ttlMs: 3_600_000, tags: [tag('raised')] });

      expect(await count(client, 'TTL', bucket)).toBeGreaterThan(3_000);
    });

    // `tier-parity.test.ts` runs these busts on the fake; this is the same two with the shared tier
    // answering out of a real server, and the assertion is the EQUALITY of what the two rungs kept —
    // never each one checked apart, which is how they came to disagree.
    describe('one bust, one answer, whichever rung holds it', () => {
      const seed = async (tier: CacheTier, entity: string): Promise<void> => {
        await tier.set(`${entity}-1`, 'one', { ttlMs: 60_000, tags: [tag(entity, '1')] });
        await tier.set(`${entity}-2`, 'two', { ttlMs: 60_000, tags: [tag(entity, '2')] });
        await tier.set(`${entity}-feed`, 'list', { ttlMs: 60_000, tags: [tag(entity)] });
      };

      const survivors = async (tier: CacheTier, entity: string): Promise<string[]> => {
        const found: string[] = [];
        for (const suffix of ['1', '2', 'feed']) {
          if ((await tier.get(`${entity}-${suffix}`)) !== undefined) found.push(suffix);
        }
        return found;
      };

      test('a ROW bust leaves the same keys in the LRU and in a real Redis', async () => {
        // The divergence this closes, measured rather than argued: the shared tier joined a
        // row-tagged key to the COLLECTION bucket and read that bucket back on a row bust, so
        // `row-2` came out of the read and was deleted — while the LRU one rung closer kept it.
        // Every single-row write emptied the shared tier for that entity, silently and per node.
        const lru = lruTier({ rng: () => 0 });
        const redis = tierOn(raw());
        await seed(lru, 'liverow');
        await seed(redis, 'liverow');

        await lru.invalidateTags([tag('liverow', '1')]);
        const cleared = await redis.invalidateTags([tag('liverow', '1')]);

        expect(await survivors(redis, 'liverow')).toEqual(await survivors(lru, 'liverow'));
        expect(await survivors(redis, 'liverow')).toEqual(['2']);
        expect([...cleared.keys].sort()).toEqual(['liverow-1', 'liverow-feed']);
      });

      test('a COLLECTION bust leaves the same keys in the LRU and in a real Redis', async () => {
        // The other direction, and the reason the entity index is a SECOND bucket rather than a
        // narrowing of the collection tag's: a collection bust must still reach every row.
        const lru = lruTier({ rng: () => 0 });
        const redis = tierOn(raw());
        await seed(lru, 'livecoll');
        await seed(redis, 'livecoll');

        await lru.invalidateTags([tag('livecoll')]);
        const cleared = await redis.invalidateTags([tag('livecoll')]);

        expect(await survivors(redis, 'livecoll')).toEqual(await survivors(lru, 'livecoll'));
        expect(await survivors(redis, 'livecoll')).toEqual([]);
        expect([...cleared.keys].sort()).toEqual(['livecoll-1', 'livecoll-2', 'livecoll-feed']);
      });
    });
    describe('the fleet-wide fence, against a server that really expires keys', () => {
      // `redis-fence.test.ts` proves the interleavings on the recording fake. What only a server
      // can say is that the generation is a LEASED key two separate connections both read.
      test('a bust on one connection withdraws a fill another connection had in flight', async () => {
        const replicaA = cacheStack([lruTier({ rng: () => 0 }), tierOn(raw())]);
        const replicaB = tierOn(raw());
        let release: (value: string) => void = () => undefined;
        const gate = new Promise<string>((resolve) => {
          release = resolve;
        });
        let started: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });

        const read = replicaA.read(
          'livefence-feed',
          () => {
            started();
            return gate;
          },
          { ttlMs: 60_000, tags: [tag('livefence', '1')] },
        );
        await entered;
        await replicaB.invalidateTags([tag('livefence', '1')]);
        release('pre-write rows');

        expect(await read).toBe('pre-write rows');
        expect(await replicaB.get('livefence-feed')).toBeUndefined();
      });

      test('a generation carries a lease, so a write-heavy entity cannot grow the keyspace forever', async () => {
        const client = raw();
        await tierOn(client).invalidateTags([tag('livelease', '1')]);

        for (const key of [`${PREFIX}:g:{livelease}:r:1`, `${PREFIX}:g:{livelease}:a`]) {
          const pttl = await count(client, 'PTTL', key);
          expect(pttl).toBeGreaterThan(0);
          expect(pttl).toBeLessThanOrEqual(120_000);
        }
      });
    });

    describe('a lost connection is a fast miss, then the tier answers again on its own', () => {
      /** Ask until `ready()` holds, or fail after `limitMs` of the server's and Bun's own time. */
      const until = async (ready: () => Promise<boolean> | boolean, limitMs: number) => {
        const started = performance.now();
        while (!(await ready())) {
          if (performance.now() - started > limitMs)
            expect.unreachable(`not ready in ${limitMs} ms`);
          // real-clock: Bun's reconnect loop and the server's socket close run on their own timers.
          await Bun.sleep(10);
        }
      };

      test('CLIENT KILL: the read is its load inside 50 ms, recorded, and the next one hits', async () => {
        const failures: CacheTierFailureEvent[] = [];
        const off = subscribe('cache.tier_failure', (event) => void failures.push(event.payload));
        // core's client, the one the tier takes when none is handed in, on a path of its own.
        const client = redisClient(`${url ?? ''}/1`);
        try {
          const tier = tierOn(client);
          await until(() => client.connected, 2_000);
          await tier.set('outage-feed', 'cached', { ttlMs: 60_000 });
          const id = String(await reply(client, 'CLIENT', ['ID']));
          expect(Number(await reply(raw(), 'CLIENT', ['KILL', 'ID', id]))).toBe(1);
          await until(() => !client.connected, 2_000);

          const stack = cacheStack([tier]);
          const started = performance.now();
          expect(await stack.read('outage-feed', () => Promise.resolve('loaded'))).toBe('loaded');
          expect(performance.now() - started).toBeLessThan(50);
          expect(failures[0]?.message).toContain('offline queue is disabled');

          await until(
            async () =>
              (await stack.read('outage-feed', () => Promise.resolve('loaded'))) === 'cached',
            5_000,
          );
          await tier.del('outage-feed');
        } finally {
          client.close();
          off();
        }
      });
    });
  },
);
