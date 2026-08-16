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
import type { RedisLike } from './redis';
import { createRedisTier, REDIS_INVALIDATE_SCRIPT } from './redis';
import { tag } from './tags';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;

/** One namespace per process: a shared server survives two runs at once, and a run that died. */
const PREFIX = `xlive-${process.pid}`;

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

  test('the invalidation script drops the buckets it was handed and no value key', async () => {
    const client = raw();
    const tier = tierOn(client);
    await tier.set('kept', 'v', { ttlMs: 60_000, tags: [tag('user', '9')] });
    const bucket = `${PREFIX}:t:{user}:9`;

    const members = await reply(client, 'EVAL', [REDIS_INVALIDATE_SCRIPT, '1', bucket]);

    expect(members).toEqual([`${PREFIX}:c:kept`]);
    expect(await count(client, 'EXISTS', bucket)).toBe(0);
    // Still there, deliberately: a script may only touch keys handed to it in `KEYS`, and a `DEL`
    // of a `SMEMBERS` result from inside Lua is "attempted to access a non-local key in a cluster
    // node" on Redis Cluster and in Dragonfly's strict mode. The tier deletes it, one key per DEL.
    expect(await count(client, 'EXISTS', `${PREFIX}:c:kept`)).toBe(1);
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
});
