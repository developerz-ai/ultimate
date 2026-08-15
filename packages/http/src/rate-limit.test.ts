import { describe, expect, test } from 'bun:test';
import { HttpError } from './errors';
import {
  assertRateLimitScope,
  type Bucket,
  createRateLimiter,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  DEFAULT_RATE_LIMIT,
  memoryRateLimitStore,
  type RateLimitConfig,
  rateLimitKey,
} from './rate-limit';

const limiterAt = (clock: { ms: number }, capacity: number, refillPerSecond: number) =>
  createRateLimiter({
    config: {
      enabled: true,
      defaultBucket: 'default',
      scope: 'process',
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

// A key falls back to the connection address, so a scan rotating through an IPv6 /64 mints one
// entry per request. These pin the two rules that keep the table flat.
describe('the memory store is bounded', () => {
  const FAST: Bucket = { capacity: 1, refillPerSecond: 1 };

  test('forgets a bucket once it has refilled, without waiting for the cap', async () => {
    const store = memoryRateLimitStore();
    await store.take('scanner', FAST, 1, 0);
    expect(store.size).toBe(1);

    // Past the refill AND past the sweep interval: the entry now answers as a missing one would.
    await store.take('other', FAST, 1, 120_000);
    expect(store.size).toBe(1);
  });

  test('holds a bucket that is still spent', async () => {
    const store = memoryRateLimitStore();
    await store.take('victim', { capacity: 10, refillPerSecond: 0.001 }, 10, 0);
    await store.take('other', FAST, 1, 120_000);
    expect(store.size).toBe(2);
  });

  test('a rotating-address scan cannot grow the table past its cap', async () => {
    const store = memoryRateLimitStore({ maxKeys: 10 });
    for (let index = 0; index < 500; index += 1) {
      await store.take(`r|ip:2001:db8::${index.toString(16)}`, FAST, 1, 0);
      expect(store.size).toBeLessThanOrEqual(10);
    }
  });

  test('the cap evicts the least-throttled key, never the most', async () => {
    const store = memoryRateLimitStore({ maxKeys: 4 });
    const slow: Bucket = { capacity: 1, refillPerSecond: 0.001 };
    const roomy: Bucket = { capacity: 100, refillPerSecond: 10 };

    // Spent, and 1000s from refilling: the entry worth keeping.
    expect((await store.take('victim', slow, 1, 0)).allowed).toBe(true);
    // Barely touched, 100ms from refilling: the entries worth forgetting.
    for (let index = 0; index < 200; index += 1) {
      await store.take(`scan-${index}`, roomy, 1, 0);
    }

    expect(store.size).toBeLessThanOrEqual(4);
    // Still denied — the scan did not buy the victim its bucket back.
    expect((await store.take('victim', slow, 1, 0)).allowed).toBe(false);
  });

  test('a bucket that never refills is forgettable only by the cap', async () => {
    const store = memoryRateLimitStore({ maxKeys: 2 });
    const stuck: Bucket = { capacity: 1, refillPerSecond: 0 };
    await store.take('stuck', stuck, 1, 0);
    // A year later it is still denied: nothing refilled it, so the sweep may not drop it.
    expect((await store.take('stuck', stuck, 1, 31_536_000_000)).allowed).toBe(false);
    expect(store.size).toBe(1);
  });

  test('reset() drops the key, and a nonsense cap still holds one entry', async () => {
    const store = memoryRateLimitStore({ maxKeys: 0 });
    await store.take('k', FAST, 1, 0);
    expect(store.size).toBe(1);
    await store.reset('k');
    expect(store.size).toBe(0);
  });

  test('the shipped cap is a few megabytes, not unbounded', () => {
    expect(DEFAULT_MAX_RATE_LIMIT_KEYS).toBeGreaterThan(1_000);
    expect(Number.isFinite(DEFAULT_MAX_RATE_LIMIT_KEYS)).toBe(true);
  });

  test('a swept key throttles again from a full bucket, not a corrupt one', async () => {
    const store = memoryRateLimitStore({ maxKeys: 1 });
    await store.take('a', FAST, 1, 0);
    await store.take('b', FAST, 1, 0);
    const fresh = await store.take('a', FAST, 1, 0);
    expect(fresh.allowed).toBe(true);
    expect(fresh.limit).toBe(1);
  });
});

// The declaration is the app's: a framework cannot see `replicas: 3`, and one that inferred it
// from the environment would be wrong on the first deployment that scaled differently.
describe('scope is declared, and checked once', () => {
  const config = (over: Partial<RateLimitConfig>): RateLimitConfig => ({
    ...DEFAULT_RATE_LIMIT,
    ...over,
  });

  test('the memory store is per-process, and says so', () => {
    expect(memoryRateLimitStore().scope).toBe('process');
    expect(createRateLimiter({ config: DEFAULT_RATE_LIMIT }).scope).toBe('process');
  });

  test('a limiter carries its store scope up, so the check reads one value', () => {
    const shared = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(createRateLimiter({ config: DEFAULT_RATE_LIMIT, store: shared }).scope).toBe('shared');
  });

  test("the default declaration accepts the per-process store — that is what 'process' means", () => {
    const limiter = createRateLimiter({ config: DEFAULT_RATE_LIMIT });
    expect(() => assertRateLimitScope(DEFAULT_RATE_LIMIT, limiter)).not.toThrow();
  });

  test('a shared declaration refuses a per-process limiter, with the fix in the error', () => {
    const declared = config({ scope: 'shared' });
    const limiter = createRateLimiter({ config: declared });
    expect(() => assertRateLimitScope(declared, limiter)).toThrow(/X_RATE_LIMIT_NOT_SHARED/);
    let thrown: unknown;
    try {
      assertRateLimitScope(declared, limiter);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    // Both exits are in the fix line: install a shared store, or accept per-replica limits.
    if (thrown instanceof HttpError) {
      expect(thrown.fix).toContain('rateLimitStore');
      expect(thrown.fix).toContain("http.rateLimit.scope: 'process'");
    }
  });

  test('a shared declaration accepts a shared limiter', () => {
    const declared = config({ scope: 'shared' });
    const store = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(() =>
      assertRateLimitScope(declared, createRateLimiter({ config: declared, store })),
    ).not.toThrow();
  });

  // A fleet-wide limit that is switched off is the claim with nothing behind it, so it is refused
  // too — otherwise `enabled: false` is a way to keep the declaration and lose the enforcement.
  test('a shared declaration with the limiter disabled is refused', () => {
    const declared = config({ scope: 'shared', enabled: false });
    const store = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(() =>
      assertRateLimitScope(declared, createRateLimiter({ config: declared, store })),
    ).toThrow(/X_RATE_LIMIT_NOT_SHARED/);
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
