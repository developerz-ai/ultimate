import { describe, expect, test } from 'bun:test';
import { type Clock, isUltimateError, type UltimateError } from '@ultimat3/core';
import { CacheTooLargeError } from './errors';
import { estimateBytes, LruCache } from './lru';
import { tag } from './tags';

/** Manual clock: TTL tests must not depend on wall time. */
function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const filler = (bytes: number): string => 'x'.repeat(bytes);

describe('LruCache byte budget', () => {
  test('evicts least-recently-used entries once the byte budget is exceeded', () => {
    const cache = new LruCache({ maxBytes: 400, defaultTtlMs: 3_600_000 });
    cache.set('a', filler(100));
    cache.set('b', filler(100));
    cache.set('c', filler(100));

    // Touch 'a' so 'b' becomes the eviction victim, not insertion order.
    expect(cache.get('a')).toBeDefined();
    cache.set('d', filler(100));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.stats().bytes).toBeLessThanOrEqual(400);
    expect(cache.stats().evictions).toBe(1);
  });

  test('bytes accounting returns to zero when every entry is deleted', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    cache.set('a', { hello: 'world' });
    cache.set('b', [1, 2, 3]);
    expect(cache.stats().bytes).toBeGreaterThan(0);
    cache.del('a');
    cache.del('b');
    expect(cache.stats().bytes).toBe(0);
    expect(cache.stats().entries).toBe(0);
  });

  test('an entry larger than the whole budget throws X_CACHE_TOO_LARGE', () => {
    const cache = new LruCache({ maxBytes: 64 });
    expect(() => cache.set('big', filler(500))).toThrow(CacheTooLargeError);
    // The failed write must not corrupt accounting.
    expect(cache.stats().bytes).toBe(0);
  });

  test('entries expire on the injected clock, not wall time', () => {
    const clock = fakeClock(1_000_000);
    const cache = new LruCache({ maxBytes: 10_000, clock, defaultTtlMs: 1_000 });
    cache.set('a', 'v');
    expect(cache.get('a')?.value).toBe('v');
    clock.advance(1_001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  test('clear() resets hit/miss/eviction counters along with entries and bytes', () => {
    const cache = new LruCache({ maxBytes: 400, defaultTtlMs: 3_600_000 });
    cache.set('a', filler(100));
    cache.set('b', filler(100));
    cache.set('c', filler(100));
    expect(cache.get('a')).toBeDefined(); // a hit; also re-touches 'a' so 'b' is evicted next
    cache.set('d', filler(100)); // evicts 'b'
    expect(cache.get('b')).toBeUndefined(); // a miss
    const before = cache.stats();
    expect(before.evictions).toBeGreaterThan(0);
    expect(before.hits).toBeGreaterThan(0);
    expect(before.misses).toBeGreaterThan(0);

    cache.clear();

    expect(cache.stats()).toEqual({
      entries: 0,
      bytes: 0,
      maxBytes: 400,
      hits: 0,
      misses: 0,
      evictions: 0,
    });
  });
});

describe('LruCache tag invalidation', () => {
  test('invalidating a tag drops only entries carrying that tag', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    cache.set('post:list', ['a'], { tags: [tag('post')] });
    cache.set('post:1', { id: '1' }, { tags: [tag('post', '1')] });
    cache.set('post:2', { id: '2' }, { tags: [tag('post', '2')] });
    cache.set('user:list', ['u'], { tags: [tag('user')] });
    cache.set('untagged', 'keep');

    const removed = cache.invalidateTags([tag('post', '1')]);

    expect([...removed].sort()).toEqual(['post:1', 'post:list']);
    expect(cache.get('post:2')).toBeDefined();
    expect(cache.get('user:list')).toBeDefined();
    expect(cache.get('untagged')).toBeDefined();
  });

  test('invalidating a collection tag sweeps every row of that entity', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    cache.set('post:1', 1, { tags: [tag('post', '1')] });
    cache.set('post:2', 2, { tags: [tag('post', '2')] });
    cache.set('user:1', 3, { tags: [tag('user', '1')] });

    const removed = cache.invalidateTags([tag('post')]);

    expect([...removed].sort()).toEqual(['post:1', 'post:2']);
    expect(cache.get('user:1')).toBeDefined();
  });

  test('overwriting a key re-indexes its tags so the stale tag no longer matches', () => {
    const cache = new LruCache({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    cache.set('k', 1, { tags: [tag('post', '1')] });
    cache.set('k', 2, { tags: [tag('user', '9')] });

    expect(cache.invalidateTags([tag('post')])).toEqual([]);
    expect(cache.get('k')?.value).toBe(2);
    expect(cache.invalidateTags([tag('user')])).toEqual(['k']);
  });
});

describe('estimateBytes', () => {
  test('measures utf-8 length, not code units', () => {
    expect(estimateBytes('abc')).toBe(3);
    expect(estimateBytes('€')).toBe(3);
    expect(estimateBytes(new Uint8Array(16))).toBe(16);
  });
});

describe('the one TTL rule', () => {
  // `0` used to be "never expires" here and `EX 1` — one second — in the Redis tier, so a stack
  // holding both answered differently depending on which one hit. Neither is what a caller
  // writing `0` means, so no tier resolves it.
  test('a ttlMs that is not positive and finite is refused, not reinterpreted', () => {
    const cache = new LruCache({ maxBytes: 10_000 });
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codeOf(() => cache.set('k', 1, { ttlMs }))).toBe('X_CACHE_TTL_INVALID');
    }
    expect(cache.get('k')).toBeUndefined();
  });

  /**
   * Moved from the first WRITE to the construction: a default nobody can spend is a defect in the
   * config line that set it, and refusing it on the write reported it one caller too late — as
   * `X_CACHE_TTL_INVALID` on a `set` whose own `ttlMs` was fine.
   */
  test('a tier default that is not a usable duration is refused where it is declared', () => {
    for (const defaultTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(codeOf(() => new LruCache({ maxBytes: 10_000, defaultTtlMs }))).toBe(
        'X_CACHE_LIMIT_INVALID',
      );
    }
    expect(new LruCache({ maxBytes: 10_000, defaultTtlMs: 1_000 }).stats().entries).toBe(0);
  });

  test('a refused overwrite leaves the entry it would have replaced', () => {
    // The reject used to land after the unlink, so `set(k, v, { ttlMs: 0 })` on a live key both
    // threw AND dropped the good value — a validation error that mutates is a second bug.
    const cache = new LruCache({ maxBytes: 10_000, clock: fakeClock(1_000) });
    cache.set('k', 'kept', { ttlMs: 5_000 });
    expect(codeOf(() => cache.set('k', 'rejected', { ttlMs: 0 }))).toBe('X_CACHE_TTL_INVALID');
    expect(cache.get<string>('k')?.value).toBe('kept');
    expect(cache.stats().entries).toBe(1);
  });

  test('every entry therefore carries a finite expiry the stack can read', () => {
    const clock = fakeClock(1_000);
    // `rng: () => 0` is the full lease: the TTL spread is on by default, so an exact expiry is
    // only assertable with the roll pinned — see `assertTtl` in `tiers.ts`.
    const cache = new LruCache({ maxBytes: 10_000, clock, rng: () => 0 });
    cache.set('k', 1, { ttlMs: 5_000 });
    expect(cache.get('k')?.expiresAt).toBe(6_000);
    clock.advance(5_000);
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('the TTL spread', () => {
  // 40,000 keys warmed by one rolling restart share one lease and therefore one expiry instant.
  // Five minutes later they all miss inside the same 30-second window.
  test('a lease is shortened by up to jitterFraction, never lengthened', () => {
    const clock = fakeClock(0);
    const highest = new LruCache({ maxBytes: 10_000, clock, rng: () => 0 });
    const lowest = new LruCache({ maxBytes: 10_000, clock, rng: () => 1 });
    highest.set('k', 1, { ttlMs: 60_000 });
    lowest.set('k', 1, { ttlMs: 60_000 });

    expect(highest.get('k')?.expiresAt).toBe(60_000);
    expect(lowest.get('k')?.expiresAt).toBe(57_000);
  });

  test('two keys written in the same millisecond do not expire in the same one', () => {
    const clock = fakeClock(0);
    const rolls = [0.1, 0.9];
    let next = 0;
    const cache = new LruCache({
      maxBytes: 10_000,
      clock,
      rng: () => rolls[next++ % rolls.length] ?? 0,
    });
    cache.set('a', 1, { ttlMs: 60_000 });
    cache.set('b', 1, { ttlMs: 60_000 });

    expect(cache.get('a')?.expiresAt).not.toBe(cache.get('b')?.expiresAt);
  });

  test('jitterFraction: 0 turns the spread off for a test that needs an exact lease', () => {
    const clock = fakeClock(0);
    const cache = new LruCache({ maxBytes: 10_000, clock, jitterFraction: 0, rng: () => 1 });
    cache.set('k', 1, { ttlMs: 60_000 });
    expect(cache.get('k')?.expiresAt).toBe(60_000);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-throw';
}

/**
 * `maxBytes` is an `app.config.ts` knob — `CacheTooLargeError`'s own `fix:` says so — which makes
 * it a value that arrives as `Number(process.env.CACHE_MAX_BYTES)`. `NaN` is not nullish, so `??`
 * passes it through, and every comparison it then reaches answers FALSE: the too-large refusal
 * never fires and, worse, `while (bytes > maxBytes)` never evicts. A cache that never evicts is
 * an unbounded `Map` keyed by whatever the app caches, which is the one failure this class exists
 * to prevent. `assertTtl` in `tiers.ts` has screened the sibling knob from the start.
 */
describe('LruCache refuses a byte budget that is not a budget', () => {
  test('NaN is refused at construction, not silently turned into "never evict"', () => {
    expect(() => new LruCache({ maxBytes: Number.NaN })).toThrow(/X_CACHE_LIMIT_INVALID/);
  });

  test('zero, negative and Infinity are refused too', () => {
    expect(() => new LruCache({ maxBytes: 0 })).toThrow(/X_CACHE_LIMIT_INVALID/);
    expect(() => new LruCache({ maxBytes: -1 })).toThrow(/X_CACHE_LIMIT_INVALID/);
    expect(() => new LruCache({ maxBytes: Number.POSITIVE_INFINITY })).toThrow(
      /X_CACHE_LIMIT_INVALID/,
    );
  });

  test('the refusal names the value and the config key that carries it', () => {
    let caught: unknown;
    try {
      new LruCache({ maxBytes: Number.NaN });
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    expect((caught as UltimateError).code).toBe('X_CACHE_LIMIT_INVALID');
    expect((caught as UltimateError).cause).toContain('NaN');
    expect((caught as UltimateError).fix).toContain('lru.maxBytes');
  });

  test('the default and an ordinary budget still construct', () => {
    expect(() => new LruCache()).not.toThrow();
    expect(new LruCache({ maxBytes: 1 }).stats().maxBytes).toBe(1);
  });
});
