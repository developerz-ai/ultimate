// What a rate limit DECLARES, refused where it is declared: the resolver over the bucket table,
// `toBucket`'s conversion of `{ limit, windowMs }`, and the screen every configured bucket passes.
import { describe, expect, test } from 'bun:test';
import { HttpError } from './errors';
import { resolveRateLimitConfig, toBucket } from './rate-limit-config';

describe('resolveRateLimitConfig', () => {
  // `scope` used to DEFAULT to `'process'`, so "we did not ask" and "the app said one replica"
  // were the same value — and `docker/helm/values.yaml` runs `roles.web.replicas: 3`, so every
  // configured number was enforced three times over with a green `x verify`. The boot check that
  // exists for this only fires on a `'shared'` declaration, i.e. never in the silent case.
  test('refuses a config that never declared where the counters live', () => {
    expect(() => resolveRateLimitConfig(undefined)).toThrow(/X_RATE_LIMIT_SCOPE_UNSET/);
    expect(() => resolveRateLimitConfig({ buckets: {} })).toThrow(/X_RATE_LIMIT_SCOPE_UNSET/);
  });

  test('names both answers, and the store that makes the second one true', () => {
    const error = (() => {
      try {
        resolveRateLimitConfig(undefined);
        return null;
      } catch (thrown) {
        return thrown as HttpError;
      }
    })();
    expect(error?.fix).toContain("scope: 'process'");
    expect(error?.fix).toContain('rateLimitStore');
  });

  test("'process' is still a legal answer — it is no longer an assumed one", () => {
    expect(resolveRateLimitConfig({ scope: 'process' }).scope).toBe('process');
    expect(resolveRateLimitConfig({ scope: 'shared' }).scope).toBe('shared');
  });

  // A limiter that is switched off has nothing to be wrong about, so it owes no declaration.
  test('a disabled limiter needs no declaration', () => {
    expect(resolveRateLimitConfig({ enabled: false }).scope).toBe('process');
  });

  test('the defaults it merges over are the shipped buckets', () => {
    const resolved = resolveRateLimitConfig({ scope: 'process' });
    expect(resolved.buckets['default']).toEqual({ capacity: 120, refillPerSecond: 2 });
    expect(resolved.buckets['auth']).toEqual({ capacity: 10, refillPerSecond: 0.2 });
  });
});

describe('toBucket', () => {
  // It lives here rather than in `@ultimat3/action` because `action` and `query` are the same
  // tier and can never import each other — a query could not declare a rate limit at all while
  // the only conversion sat in its sibling.
  test('a declaration becomes the capacity and the refill the limiter runs on', () => {
    expect(toBucket('contactSales', { limit: 5, windowMs: 600_000 })).toEqual({
      capacity: 5,
      refillPerSecond: 5 / 600,
    });
  });

  test('a limit under one request is a closed endpoint, not a limited one', () => {
    expect(() => toBucket('x', { limit: 0, windowMs: 1_000 })).toThrow(/X_RATE_LIMIT_INVALID/);
  });

  test('a window of zero is a limit that enforces nothing', () => {
    expect(() => toBucket('x', { limit: 5, windowMs: 0 })).toThrow(/X_RATE_LIMIT_INVALID/);
  });

  // The COMPUTED rate, not just the two declared halves: both of these read fine and neither is
  // a bucket the limiter can run on.
  test('a pair that computes to an infinite refill is refused', () => {
    expect(() => toBucket('x', { limit: Number.MAX_VALUE, windowMs: 1 })).toThrow(
      /X_RATE_LIMIT_INVALID/,
    );
  });

  test('the cause names the owner and both declared numbers', () => {
    const error = (() => {
      try {
        toBucket('contactSales', { limit: 5, windowMs: 0 });
        return null;
      } catch (thrown) {
        return thrown as HttpError;
      }
    })();
    expect(error?.cause).toContain('contactSales');
    expect(error?.cause).toContain('windowMs: 0');
    expect(error?.fix).toContain('{ limit: 5, windowMs: 600_000 }');
  });
});

describe('a configured bucket is screened where it is declared', () => {
  test.each([
    [{ capacity: 3, refillPerSecond: 0 }, 'refillPerSecond'],
    [{ capacity: 3, refillPerSecond: -1 }, 'refillPerSecond'],
    [{ capacity: 3, refillPerSecond: Number.NaN }, 'refillPerSecond'],
    [{ capacity: 3, refillPerSecond: Number.POSITIVE_INFINITY }, 'refillPerSecond'],
    [{ capacity: 0.5, refillPerSecond: 1 }, 'capacity'],
    [{ capacity: Number.NaN, refillPerSecond: 1 }, 'capacity'],
  ])('%p is X_CONFIG_INVALID naming %s', (bucket, field) => {
    let thrown: unknown;
    try {
      resolveRateLimitConfig({ scope: 'process', buckets: { default: bucket } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe('X_CONFIG_INVALID');
    expect((thrown as HttpError).cause).toContain(`rateLimit.buckets.default.${field}`);
  });

  test('the shipped table and an ordinary declaration pass', () => {
    expect(() => resolveRateLimitConfig({ scope: 'process' })).not.toThrow();
    expect(() =>
      resolveRateLimitConfig({
        scope: 'process',
        buckets: { default: { capacity: 1, refillPerSecond: 0.0001 } },
      }),
    ).not.toThrow();
  });
});
