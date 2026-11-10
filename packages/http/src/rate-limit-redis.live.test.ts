// What only a Redis key can show: its TTL tracks the refill, and reset deletes it. Every answer the
// store owes through its port is `@ultimat3/testing`'s `rateLimitStoreConformance`, run over this
// store in `packages/testing/src/rate-limit-store-conformance-redis.live.test.ts`. Skips unless a
// Redis is configured:
//
//   set -a; . docker/test-services.env; set +a
//   bun test packages/http/src/rate-limit-redis.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { redisClient } from '@ultimat3/core/redis';
import { type Bucket, memoryRateLimitStore, type RateLimitStore } from './rate-limit';
import { redisRateLimitStore } from './rate-limit-redis';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;
// One namespace per run, so two runs against one server never share a bucket.
const PREFIX = `xlive-rl-${crypto.randomUUID()}`;
const NOW = 1_700_000_000_000;
const bucket: Bucket = { capacity: 3, refillPerSecond: 0.5 };

describe.skipIf(!hasRedis)('live · redis rate-limit store', () => {
  const client = hasRedis ? redisClient(url) : undefined;
  const store = (): RateLimitStore =>
    redisRateLimitStore({ client: client as NonNullable<typeof client>, prefix: PREFIX });

  // Connected up front: core's client refuses a command while it is still dialling (no offline
  // queue), and the store would then DEGRADE to memory — a green run that never touched Redis.
  beforeAll(async () => {
    await client?.connect();
  });
  afterAll(() => client?.close());

  test('the key expires once it would be full again, and reset deletes it', async () => {
    const shared = store();
    const key = `ttl-${crypto.randomUUID()}`;
    await shared.take(key, bucket, 1, NOW);
    const live = client as NonNullable<typeof client>;
    const ttl = Number(await live.send('PTTL', [`${PREFIX}:rl:${key}`]));
    // One token short at 0.5/s is 2 s to full.
    expect(ttl).toBeGreaterThan(1_000);
    expect(ttl).toBeLessThanOrEqual(2_000);
    await shared.reset(key);
    expect(Number(await live.send('EXISTS', [`${PREFIX}:rl:${key}`]))).toBe(0);
  });

  // A window past a day is a real declaration — five per week — and the key must live as long
  // as the bucket takes to refill: expiring it sooner hands the caller a fresh week every day.
  test('a five-per-week bucket stays spent past a day, as the memory store says', async () => {
    const shared = store();
    const memory = memoryRateLimitStore();
    const weekly: Bucket = { capacity: 5, refillPerSecond: 5 / (7 * 86_400) };
    const key = `weekly-${crypto.randomUUID()}`;
    for (let index = 0; index < 5; index += 1) {
      expect(await shared.take(key, weekly, 1, NOW)).toEqual(
        await memory.take(key, weekly, 1, NOW),
      );
    }
    const ttl = Number(
      await (client as NonNullable<typeof client>).send('PTTL', [`${PREFIX}:rl:${key}`]),
    );
    expect(ttl).toBeGreaterThan(6 * 86_400_000);
    // A day and a fifth on, the week has refilled 0.86 of one token: still refused.
    const pastADay = NOW + 1.2 * 86_400_000;
    const refused = await shared.take(key, weekly, 1, pastADay);
    expect(refused).toEqual(await memory.take(key, weekly, 1, pastADay));
    expect(refused.allowed).toBe(false);
  });
});
