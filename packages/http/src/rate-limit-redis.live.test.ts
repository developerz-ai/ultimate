// The only proof the take script is Lua, and is the token bucket every other store answers: a
// real server runs it. Skips unless a Redis is configured:
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

  const exists = async (key: string): Promise<boolean> =>
    Number(await (client as NonNullable<typeof client>).send('EXISTS', [`${PREFIX}:rl:${key}`])) ===
    1;

  // The same sequence against both stores: every decision field must agree, or two drivers give
  // two answers to "may I" and "when may I come back".
  test('answers exactly what the memory store answers, take by take', async () => {
    const shared = store();
    const memory = memoryRateLimitStore();
    const key = `same-${crypto.randomUUID()}`;
    const steps: readonly [number, number][] = [
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [700, 1],
      [1_300, 1],
      [2_000, 2],
      [60_000, 1],
    ];
    for (const [at, cost] of steps) {
      const want = await memory.take(key, bucket, cost, NOW + at);
      const got = await shared.take(key, bucket, cost, NOW + at);
      expect(got).toEqual(want);
      expect(await shared.peek(key, bucket, NOW + at)).toEqual(
        await memory.peek(key, bucket, NOW + at),
      );
    }
    // Proof the answers came from the server and not from the degraded fallback.
    expect(await exists(key)).toBe(true);
  });

  test('a fractional token survives the round trip — 0.5 left is not 0', async () => {
    const shared = store();
    const key = `half-${crypto.randomUUID()}`;
    for (let index = 0; index < 3; index += 1) await shared.take(key, bucket, 1, NOW);
    // 1 s at 0.5/s: half a token, so still refused, and the wait is one more second.
    const refused = await shared.take(key, bucket, 1, NOW + 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
    expect((await shared.take(key, bucket, 1, NOW + 2_000)).allowed).toBe(true);
  });

  test('a clock behind the stored one grants nothing', async () => {
    const shared = store();
    const key = `skew-${crypto.randomUUID()}`;
    for (let index = 0; index < 3; index += 1) await shared.take(key, bucket, 1, NOW + 10_000);
    expect((await shared.take(key, bucket, 1, NOW)).allowed).toBe(false);
  });

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

  test('concurrent takes on one hot key spend exactly the capacity', async () => {
    const shared = store();
    const key = `hot-${crypto.randomUUID()}`;
    const hot: Bucket = { capacity: 50, refillPerSecond: 0.001 };
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () => shared.take(key, hot, 1, NOW)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(50);
    expect(await exists(key)).toBe(true);
  });
});
