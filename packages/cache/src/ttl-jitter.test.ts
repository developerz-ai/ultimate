// The spread `assertTtl` applies after it validates. A rolling restart warms 40,000 keys inside
// 30 seconds on one lease; five minutes later they all expire inside one 30-second window. Every
// assertion here pins a roll, because a jitter you cannot pin is a test you cannot write.

import { describe, expect, test } from 'bun:test';
import { CacheJitterInvalidError, CacheTtlInvalidError } from './errors';
import { assertTtl, DEFAULT_TTL_JITTER_FRACTION } from './tiers';

describe('assertTtl spreads the lease it validates', () => {
  test('an invalid ttl is still refused before anything is spread', () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertTtl('k', ttlMs, 'lru')).toThrow(CacheTtlInvalidError);
    }
  });

  test('the default fraction shaves off at most 5%, and rng() === 0 is the full lease', () => {
    expect(DEFAULT_TTL_JITTER_FRACTION).toBe(0.05);
    expect(assertTtl('k', 300_000, 'redis', { rng: () => 0 })).toBe(300_000);
    expect(assertTtl('k', 300_000, 'redis', { rng: () => 1 })).toBe(285_000);
    expect(assertTtl('k', 300_000, 'redis', { rng: () => 0.5 })).toBe(292_500);
  });

  test('jitterFraction: 0 disables the spread entirely — the deterministic setting', () => {
    expect(assertTtl('k', 60_000, 'lru', { jitterFraction: 0, rng: () => 1 })).toBe(60_000);
  });

  test('a fraction outside [0, 1) is refused, not clamped', () => {
    for (const jitterFraction of [1, 1.5, -0.1, Number.NaN]) {
      expect(() => assertTtl('k', 1_000, 'lru', { jitterFraction })).toThrow(
        CacheJitterInvalidError,
      );
    }
  });

  test('an rng outside [0, 1) can never EXTEND the lease past what the caller asked for', () => {
    expect(assertTtl('k', 1_000, 'lru', { rng: () => -5 })).toBe(1_000);
    expect(assertTtl('k', 1_000, 'lru', { rng: () => 99 })).toBe(950);
  });

  test('a spread lease is never rounded down to zero', () => {
    expect(assertTtl('k', 1, 'lru', { jitterFraction: 0.9, rng: () => 1 })).toBe(1);
  });
});
