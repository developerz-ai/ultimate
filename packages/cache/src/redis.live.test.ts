// The only proof the two Lua scripts are Lua. Every other test in this package hands `EVAL` to a
// fake that cannot run a script, so the bodies are inert text: gutted to `return 1` / `return {}`
// they left all 517 tests in `cache` + `query` green, and the second one is the whole shared-tier
// invalidation path. A real server is the only thing that has an opinion about a script.
//
// Skips unless a Redis is configured. Locally:
//
//   docker run -d --name x-redis -p 6379:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://localhost:6379 bun test packages/cache/src/redis.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { createLruTier } from './lru';
import type { RedisLike } from './redis';
import { createRedisTier, REDIS_INVALIDATE_SCRIPT } from './redis';
import { tag } from './tags';
import type { CacheTier } from './tiers';

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

describe.skipIf(!hasRedis)('live · redis · both Lua scripts, executed by a real server', () => {
  const opened: LiveClient[] = [];

  const raw = (): LiveClient => {
    const client: LiveClient = new Bun.RedisClient(url ?? '');
    opened.push(client);
    return client;
  };

  const tierOn = (client: RedisLike) =>
    createRedisTier({ client, prefix: PREFIX, buildId: null, rng: () => 0 });

  afterAll(async () => {
    // `KEYS` is what this package refuses to ship as an invalidation path; over a namespace this
    // process owns, in a teardown, it is the cheapest way to leave the server as we found it.
    const client = raw();
    const found = await reply(client, 'KEYS', [`${PREFIX}:*`]);
    for (const key of Array.isArray(found) ? found : []) await reply(client, 'DEL', [String(key)]);
    for (const created of opened) created.close();
  });

  test('set → tag join → invalidateTags → miss, end to end through both scripts', async () => {
    const tier = tierOn(raw());
    await tier.set('feed', { n: 1 }, { ttlMs: 60_000, tags: [tag('post', '1')] });

    expect((await tier.get<{ n: number }>('feed'))?.value).toEqual({ n: 1 });

    const result = await tier.invalidateTags([tag('post', '1')]);

    // With the script gutted the members never come back: the tier deletes nothing client-side,
    // `report.errors` stays empty, the bust reads as clean and every node serves the pre-write
    // row until its own TTL runs out.
    expect(result.keys).toEqual(['feed']);
    expect(await tier.get('feed')).toBeUndefined();
  });

  test('the invalidation script reads the buckets it was handed and deletes NOTHING', async () => {
    const client = raw();
    const tier = tierOn(client);
    await tier.set('kept', 'v', { ttlMs: 60_000, tags: [tag('user', '9')] });
    const bucket = `${PREFIX}:t:{user}:9`;

    const members = await reply(client, 'EVAL', [REDIS_INVALIDATE_SCRIPT, '1', bucket]);

    expect(members).toEqual([`${PREFIX}:c:kept`]);
    // The value key is untouched deliberately: a script may only reach keys handed to it in
    // `KEYS`, and a `DEL` of a `SMEMBERS` result from inside Lua is "attempted to access a
    // non-local key in a cluster node" on Redis Cluster and in Dragonfly's strict mode.
    expect(await count(client, 'EXISTS', `${PREFIX}:c:kept`)).toBe(1);
    // And the BUCKET is untouched too, which is the newer half. Dropping it here made a refused
    // client-side `DEL` permanent: the member had no bucket left to be found in, so the retry the
    // error asks for cleared nothing and the row served until its own TTL.
    expect(await count(client, 'EXISTS', bucket)).toBe(1);
  });

  test('the TIER empties the bucket, one SREM of what it actually deleted', async () => {
    const client = raw();
    const tier = tierOn(client);
    await tier.set('swept', 'v', { ttlMs: 60_000, tags: [tag('swept', '11')] });
    const bucket = `${PREFIX}:t:{swept}:11`;
    expect(await count(client, 'SCARD', bucket)).toBe(1);

    expect((await tier.invalidateTags([tag('swept', '11')])).keys).toEqual(['swept']);

    // An emptied set is a set Redis removes, so the end state matches the old in-script `DEL` —
    // reached by a path where a failure leaves the membership behind instead of orphaning it.
    expect(await count(client, 'EXISTS', bucket)).toBe(0);
    expect(await count(client, 'EXISTS', `${PREFIX}:c:swept`)).toBe(0);
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
    const tier = createRedisTier({ client: racing, prefix: PREFIX, buildId: null, rng: () => 0 });

    await tier.set('raced', 'v', { ttlMs: 60_000, tags: [tag('raced')] });

    expect(busted).toBe(true);
    expect(await tier.get('raced')).toBeUndefined();
  });

  test('a fresh bucket comes out of the join with a lease, never immortal', async () => {
    const client = raw();
    const tier = tierOn(client);
    await tier.set('fresh', 'v', { ttlMs: 60_000, tags: [tag('freshly')] });

    // 60s member + the 60s grace. `-1` is the unbounded set that turns one publish into a
    // multi-million-member `SMEMBERS` (what `EXPIRE … GT` alone leaves behind); `-2` is a bucket
    // the `SADD` never created.
    const ttl = await count(client, 'TTL', `${PREFIX}:t:{freshly}`);
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  test('a short-lived member cannot shorten the bucket a long-lived one is in', async () => {
    const client = raw();
    const tier = tierOn(client);
    const bucket = `${PREFIX}:t:{shortened}`;
    await tier.set('long', 'v', { ttlMs: 3_600_000, tags: [tag('shortened')] });
    await tier.set('short', 'v', { ttlMs: 60_000, tags: [tag('shortened')] });

    // Shortened, `long` is unreachable by tag and serves stale until its own lease runs out.
    expect(await count(client, 'TTL', bucket)).toBeGreaterThan(3_000);
    expect(await count(client, 'SCARD', bucket)).toBe(2);
  });

  test('a longer member raises the lease: the bucket must outlive what it points at', async () => {
    const client = raw();
    const tier = tierOn(client);
    const bucket = `${PREFIX}:t:{raised}`;
    await tier.set('short', 'v', { ttlMs: 60_000, tags: [tag('raised')] });
    await tier.set('long', 'v', { ttlMs: 3_600_000, tags: [tag('raised')] });

    expect(await count(client, 'TTL', bucket)).toBeGreaterThan(3_000);
  });

  // `tier-parity.test.ts` compares the memo and the LRU as real objects and the shared tier on the
  // wire, because a fake cannot run `SMEMBERS`. Here it can: this is the same two busts with the
  // shared tier answering out of a real server, and the assertion is the EQUALITY of what the two
  // rungs kept — never each one checked apart, which is how they came to disagree.
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
      // `row-2` came out of `SMEMBERS` and was deleted — while the LRU one rung closer kept it.
      // Every single-row write emptied the shared tier for that entity, silently and per node.
      const lru = createLruTier({ rng: () => 0 });
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
      const lru = createLruTier({ rng: () => 0 });
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
});
