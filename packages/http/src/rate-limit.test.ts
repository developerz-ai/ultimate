import { describe, expect, test } from 'bun:test';
import { createRateLimiter, DEFAULT_RATE_LIMIT, rateLimitKey } from './rate-limit';

const limiterAt = (clock: { ms: number }, capacity: number, refillPerSecond: number) =>
  createRateLimiter({
    config: {
      enabled: true,
      defaultBucket: 'default',
      buckets: { default: { capacity, refillPerSecond } },
    },
    now: () => clock.ms,
  });

describe('token bucket', () => {
  test('spends the burst then denies with a usable retry-after', async () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 3, 1);
    for (let index = 0; index < 3; index += 1) {
      expect((await limiter.check('k', 'default')).allowed).toBe(true);
    }
    const denied = await limiter.check('k', 'default');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(1);
  });

  test('refills over time, capped at capacity', async () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 2, 1);
    await limiter.check('k', 'default');
    await limiter.check('k', 'default');
    expect((await limiter.check('k', 'default')).allowed).toBe(false);

    clock.ms = 1_000;
    expect((await limiter.check('k', 'default')).allowed).toBe(true);

    clock.ms = 60_000;
    const refilled = await limiter.check('k', 'default');
    expect(refilled.allowed).toBe(true);
    expect(refilled.remaining).toBeLessThanOrEqual(2);
  });

  test('buckets are independent per key', async () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 1, 0.1);
    expect((await limiter.check('a', 'default')).allowed).toBe(true);
    expect((await limiter.check('a', 'default')).allowed).toBe(false);
    expect((await limiter.check('b', 'default')).allowed).toBe(true);
  });

  test('assert() throws X_RATE_LIMITED with a fix line', async () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 1, 1);
    await limiter.assert('k', 'default');
    await expect(limiter.assert('k', 'default')).rejects.toThrow(/X_RATE_LIMITED|refills in/);
  });

  test('an unknown bucket name falls back to the default bucket', async () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 1, 1);
    expect((await limiter.check('k', 'does-not-exist')).limit).toBe(1);
  });
});

describe('keys', () => {
  test('actor beats org beats ip, so one user cannot drain a tenant', () => {
    expect(
      rateLimitKey({ actorId: 'a1', orgId: 'o1', ip: '1.2.3.4', routeName: 'posts.create' }),
    ).toBe('posts.create|actor:a1');
    expect(rateLimitKey({ actorId: null, orgId: 'o1', ip: '1.2.3.4', routeName: 'r' })).toBe(
      'r|org:o1',
    );
    expect(rateLimitKey({ actorId: null, orgId: null, ip: '1.2.3.4', routeName: 'r' })).toBe(
      'r|ip:1.2.3.4',
    );
    expect(rateLimitKey({ actorId: null, orgId: null, ip: null, routeName: 'r' })).toBe(
      'r|ip:unknown',
    );
  });

  test('the shipped defaults keep auth endpoints far slower than reads', () => {
    const auth = DEFAULT_RATE_LIMIT.buckets['auth'];
    const read = DEFAULT_RATE_LIMIT.buckets['default'];
    expect(auth?.capacity).toBeLessThan(read?.capacity ?? 0);
    expect(auth?.refillPerSecond).toBeLessThan(read?.refillPerSecond ?? 0);
  });
});
