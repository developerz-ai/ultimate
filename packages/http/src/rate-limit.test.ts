import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { HttpError } from './errors';
import {
  assertRateLimitScope,
  type Bucket,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  memoryRateLimitStore,
  type RateLimitConfig,
  rateLimiter,
  rateLimitSpends,
  TENANT_SCOPE,
} from './rate-limit';
import { DEFAULT_RATE_LIMIT } from './rate-limit-config';

const limiterAt = (clock: FrozenClock, capacity: number, refillPerSecond: number) =>
  rateLimiter({
    config: {
      enabled: true,
      defaultBucket: 'default',
      tenantBucket: null,
      scope: 'process',
      buckets: { default: { capacity, refillPerSecond } },
    },
    clock,
  });

/**
 * The production path — `httpServer` and `httpPipeline` both build their limiter here — read
 * `Date.now()` until 2026-08-19, so no test clock could reach the bucket maths that decides
 * whether a caller is throttled. `@ultimat3/auth`'s credential limiter has taken an injected
 * `Clock` since it shipped; this is the same rule on the same tier.
 */
describe('the clock is injected, never ambient', () => {
  test('refill is decided by the injected clock and by nothing else', async () => {
    const clock = frozenClock(0);
    const limiter = rateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 2, refillPerSecond: 1 } },
      },
      clock,
    });
    expect((await limiter.check('k', 'default')).allowed).toBe(true);
    expect((await limiter.check('k', 'default')).allowed).toBe(true);
    expect((await limiter.check('k', 'default')).allowed).toBe(false);

    // Real time passes across these awaits and the frozen clock does not, so a bucket refilling
    // on `Date.now()` cannot be told apart from one refilling on the injected clock without both
    // halves: still denied here, allowed only once the clock is advanced by hand.
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect((await limiter.check('k', 'default')).allowed).toBe(false);

    clock.advance(1_000);
    expect((await limiter.check('k', 'default')).allowed).toBe(true);
  });

  test('the reset header counts from the injected clock too', async () => {
    const clock = frozenClock(0);
    const limiter = rateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 1, refillPerSecond: 1 } },
      },
      clock,
    });
    await limiter.check('k', 'default');
    const denied = await limiter.check('k', 'default');
    // An absolute instant on the injected clock, not an offset from an ambient one: reading
    // `Date.now()` here answers ~1.7e12, which is what made the two halves impossible to pin.
    expect(denied.resetAtMs).toBe(1_000);
    clock.advance(600);
    expect(limiter.headers(denied)['ratelimit-reset']).toBe('1');
  });
});

describe('token bucket', () => {
  test('spends the burst then denies with a usable retry-after', async () => {
    const clock = frozenClock(0);
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
    const clock = frozenClock(0);
    const limiter = limiterAt(clock, 2, 1);
    await limiter.check('k', 'default');
    await limiter.check('k', 'default');
    expect((await limiter.check('k', 'default')).allowed).toBe(false);

    clock.set(1_000);
    expect((await limiter.check('k', 'default')).allowed).toBe(true);

    clock.set(60_000);
    const refilled = await limiter.check('k', 'default');
    expect(refilled.allowed).toBe(true);
    expect(refilled.remaining).toBeLessThanOrEqual(2);
  });

  test('buckets are independent per key', async () => {
    const clock = frozenClock(0);
    const limiter = limiterAt(clock, 1, 0.1);
    expect((await limiter.check('a', 'default')).allowed).toBe(true);
    expect((await limiter.check('a', 'default')).allowed).toBe(false);
    expect((await limiter.check('b', 'default')).allowed).toBe(true);
  });

  test('assert() throws X_RATE_LIMITED with a fix line', async () => {
    const clock = frozenClock(0);
    const limiter = limiterAt(clock, 1, 1);
    await limiter.assert('k', 'default');
    await expect(limiter.assert('k', 'default')).rejects.toThrow(/X_RATE_LIMITED|refills in/);
  });

  test('an unknown bucket name falls back to the default bucket', async () => {
    const clock = frozenClock(0);
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

  /**
   * The cap on this table is the only thing between a rotating-address scan and the process's
   * memory — the test above is exactly that scenario. It was `Math.max(1, Math.floor(maxKeys))`,
   * which is a clamp and not a validator: `Math.floor(NaN)` is `NaN`, `Math.max(1, NaN)` is `NaN`,
   * and `buckets.size <= NaN` is false in the sweep AND `buckets.size > NaN` is false in `take`,
   * so the sweep is never triggered and would evict nothing if it were. The cap is gone, and the
   * keys are addresses the caller chooses.
   */
  test('a cap that is not a number is refused, never a table with no cap', () => {
    for (const maxKeys of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => memoryRateLimitStore({ maxKeys })).toThrow(/X_CONFIG_INVALID/);
    }
    expect(() => memoryRateLimitStore({ maxKeys: 1 })).not.toThrow();
    expect(() => memoryRateLimitStore()).not.toThrow();
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

  test('reset() drops the key', async () => {
    const store = memoryRateLimitStore({ maxKeys: 1 });
    await store.take('k', FAST, 1, 0);
    expect(store.size).toBe(1);
    await store.reset('k');
    expect(store.size).toBe(0);
  });

  // This used to read "a nonsense cap still holds one entry" and pass `maxKeys: 0`, which
  // `Math.max(1, …)` clamped to 1 — a store that forgets every second key is not a rate limiter,
  // and the clamp is what let `NaN` through beside it. A cap of zero is now a refusal.
  test('a cap of zero is refused rather than clamped to one', () => {
    expect(() => memoryRateLimitStore({ maxKeys: 0 })).toThrow(/X_CONFIG_INVALID/);
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
  // `DEFAULT_RATE_LIMIT` no longer carries a scope — that is the whole of H8 — so a test that
  // wants a resolved config says which one it means, exactly as an app now has to.
  const PROCESS: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, scope: 'process' };
  const config = (over: Partial<RateLimitConfig>): RateLimitConfig => ({
    ...PROCESS,
    ...over,
  });

  test('the memory store is per-process, and says so', () => {
    expect(memoryRateLimitStore().scope).toBe('process');
    expect(rateLimiter({ config: PROCESS }).scope).toBe('process');
  });

  test('a limiter carries its store scope up, so the check reads one value', () => {
    const shared = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(rateLimiter({ config: PROCESS, store: shared }).scope).toBe('shared');
  });

  test("the default declaration accepts the per-process store — that is what 'process' means", () => {
    const limiter = rateLimiter({ config: PROCESS });
    expect(() => assertRateLimitScope(PROCESS, limiter)).not.toThrow();
  });

  test('a shared declaration refuses a per-process limiter, with the fix in the error', () => {
    const declared = config({ scope: 'shared' });
    const limiter = rateLimiter({ config: declared });
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
      expect(thrown.fix).toContain("scope: 'process'");
    }
  });

  test('a shared declaration accepts a shared limiter', () => {
    const declared = config({ scope: 'shared' });
    const store = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(() =>
      assertRateLimitScope(declared, rateLimiter({ config: declared, store })),
    ).not.toThrow();
  });

  // A fleet-wide limit that is switched off is the claim with nothing behind it, so it is refused
  // too — otherwise `enabled: false` is a way to keep the declaration and lose the enforcement.
  test('a shared declaration with the limiter disabled is refused', () => {
    const declared = config({ scope: 'shared', enabled: false });
    const store = { ...memoryRateLimitStore(), scope: 'shared' as const };
    expect(() => assertRateLimitScope(declared, rateLimiter({ config: declared, store }))).toThrow(
      /X_RATE_LIMIT_NOT_SHARED/,
    );
  });
});

describe('keys', () => {
  const NO_TENANT = { route: 'default', tenant: null } as const;
  const keys = (
    parts: Parameters<typeof rateLimitSpends>[0],
    buckets: Parameters<typeof rateLimitSpends>[1] = NO_TENANT,
  ): readonly string[] => rateLimitSpends(parts, buckets).map((spend) => spend.key);

  test('the caller key is actor, then org, then ip', () => {
    expect(keys({ actorId: 'a1', orgId: 'o1', ip: '1.2.3.4', routeName: 'posts.create' })).toEqual([
      'posts.create|actor:a1',
    ]);
    expect(keys({ actorId: null, orgId: 'o1', ip: '1.2.3.4', routeName: 'r' })).toEqual([
      'r|org:o1',
    ]);
    expect(keys({ actorId: null, orgId: null, ip: '1.2.3.4', routeName: 'r' })).toEqual([
      'r|ip:1.2.3.4',
    ]);
    expect(keys({ actorId: null, orgId: null, ip: null, routeName: 'r' })).toEqual([
      'r|ip:unknown',
    ]);
  });

  // v31: an IPv6 caller is its /64 — the block one subscriber holds — never the full address,
  // which minted a fresh bucket per request for anyone rotating the host half.
  test('two addresses in one IPv6 /64 spend one bucket; the next /64 another', () => {
    const anon = (ip: string): readonly string[] =>
      keys({ actorId: null, orgId: null, ip, routeName: 'r' });
    expect(anon('2001:db8:1:2::1')).toEqual(['r|ip:2001:db8:1:2::/64']);
    expect(anon('2001:db8:1:2:dead:beef:0:7')).toEqual(anon('2001:db8:1:2::1'));
    expect(anon('2001:db8:1:3::1')).not.toEqual(anon('2001:db8:1:2::1'));
    expect(anon('::ffff:1.2.3.4')).toEqual(['r|ip:1.2.3.4']);
    // One /64 however it is spelled: expanded, upper-case, zone-suffixed, dotted tail.
    for (const spelling of [
      '2001:0DB8:0001:0002:0:0:0:9',
      '2001:db8:1:2::abcd%eth0',
      '2001:db8:1:2:0:0:1.2.3.4',
    ]) {
      expect(anon(spelling)).toEqual(anon('2001:db8:1:2::1'));
    }
    // IPv4 stays one address each, and a value that is no address is kept whole.
    expect(anon('203.0.113.8')).not.toEqual(anon('203.0.113.7'));
    expect(anon('not-an-ip')).toEqual(['r|ip:not-an-ip']);
  });

  // The finding this function was rewritten for: precedence used to be EXCLUSIVE, so an
  // authenticated request never touched an org bucket and a tenant's seats were only ever limited
  // one at a time. Two actors, one org, one shared key.
  test('two actors in one org spend their own bucket AND the same tenant bucket', () => {
    const tenant = { route: 'default', tenant: 'tenant' } as const;
    expect(
      keys({ actorId: 'a1', orgId: 'o1', ip: null, routeName: 'posts.create' }, tenant),
    ).toEqual(['posts.create|actor:a1', `${TENANT_SCOPE}|org:o1`]);
    expect(keys({ actorId: 'a2', orgId: 'o1', ip: null, routeName: 'posts.list' }, tenant)).toEqual(
      ['posts.list|actor:a2', `${TENANT_SCOPE}|org:o1`],
    );
  });

  // Not `${routeName}|org:` — a per-route tenant key hands one org its whole allowance once per
  // route, which is the same number multiplied by the route table rather than a tenant cap.
  test('the tenant key is not scoped to the route', () => {
    const spends = rateLimitSpends(
      { actorId: 'a1', orgId: 'o1', ip: null, routeName: 'posts.create' },
      { route: 'default', tenant: 'tenant' },
    );
    expect(spends[1]?.key).not.toContain('posts.create');
    expect(spends[1]?.bucket).toBe('tenant');
  });

  test('no tenant bucket declared, or no org on the caller, is one key', () => {
    expect(
      keys({ actorId: 'a1', orgId: 'o1', ip: null, routeName: 'r' }, { route: 'r', tenant: null }),
    ).toHaveLength(1);
    expect(
      keys({ actorId: 'a1', orgId: null, ip: null, routeName: 'r' }, { route: 'r', tenant: 't' }),
    ).toHaveLength(1);
  });

  test('the shipped defaults keep auth endpoints far slower than reads', () => {
    const auth = DEFAULT_RATE_LIMIT.buckets['auth'];
    const read = DEFAULT_RATE_LIMIT.buckets['default'];
    expect(auth?.capacity).toBeLessThan(read?.capacity ?? 0);
    expect(auth?.refillPerSecond).toBeLessThan(read?.refillPerSecond ?? 0);
  });
});

describe('the bucket table is indexed, never walked up the prototype chain', () => {
  const limiterOver = (buckets: Record<string, Bucket>, defaultBucket = 'default') =>
    rateLimiter({
      config: { enabled: true, defaultBucket, tenantBucket: null, scope: 'process', buckets },
    });

  test('a name every object answers to falls through to the default bucket', async () => {
    // `buckets` is a plain object literal, so `buckets['constructor']` reads `Object` itself and
    // the limiter runs on a `Bucket` whose `capacity` is `undefined` — a decision about nothing.
    const limiter = limiterOver({ default: { capacity: 2, refillPerSecond: 0 } });
    expect((await limiter.check('k1', 'constructor')).limit).toBe(2);
    expect((await limiter.check('k2', 'toString')).limit).toBe(2);
    expect((await limiter.check('k3', '__proto__')).limit).toBe(2);
  });

  test('and it still runs out, rather than allowing forever', async () => {
    const limiter = limiterOver({ default: { capacity: 1, refillPerSecond: 0 } });
    expect((await limiter.check('caller', 'constructor')).allowed).toBe(true);
    expect((await limiter.check('caller', 'constructor')).allowed).toBe(false);
  });

  test('a DEFAULT bucket named off the prototype falls through to the shipped floor', async () => {
    const limiter = limiterOver({}, 'valueOf');
    expect((await limiter.check('k', 'alsoMissing')).limit).toBe(
      DEFAULT_RATE_LIMIT.buckets['default']?.capacity ?? 0,
    );
  });
});

// A configured bucket gets the rule a declared one gets from `toBucket`: a refill of 0 is a bucket
// that never forgets, which on a shared store is a key held forever per caller — and a caller
// rotating its IPv6 /64s mints them without bound.

describe('the clock port', () => {
  test('a limiter built with no clock reads the installed clock at each call, not at build', async () => {
    const config = { ...DEFAULT_RATE_LIMIT, scope: 'process' as const };
    const limiter = rateLimiter({ config });
    const atMs = Date.parse('2030-01-01T00:00:00.000Z');
    // The answer a limiter PINNED to the frozen instant gives — the unpinned one must agree.
    const pinned = await rateLimiter({ config, clock: frozenClock(atMs) }).check('k', 'default');
    const release = installClock(frozenClock(atMs));
    try {
      const decision = await limiter.check('k', 'default');
      expect(decision.resetAtMs).toBe(pinned.resetAtMs);
    } finally {
      release();
    }
  });
});
