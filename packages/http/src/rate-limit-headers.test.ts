// One rendering of a decision as `RateLimit-*`: the limiter, a bearer mount and a primitive's
// own bucket all answer through it, so a client reads one shape whoever counted.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createRequestContext } from './context';
import { createRateLimiter, DEFAULT_RATE_LIMIT, type RateLimitDecision } from './rate-limit';
import { publishRateLimit, rateLimitHeaders } from './rate-limit-headers';

const decision: RateLimitDecision = {
  allowed: true,
  limit: 5,
  remaining: 3,
  resetAtMs: 10_400,
  retryAfterSeconds: 0,
};

describe('rateLimitHeaders', () => {
  test('limit, remaining, and whole seconds to the reset', () => {
    expect(rateLimitHeaders(decision, 10_000)).toEqual({
      'ratelimit-limit': '5',
      'ratelimit-remaining': '3',
      'ratelimit-reset': '1',
    });
  });

  test('a reset already passed reads 0, never a negative count', () => {
    expect(rateLimitHeaders(decision, 20_000)['ratelimit-reset']).toBe('0');
  });

  test('the limiter answers through it', () => {
    const limiter = createRateLimiter({
      config: { ...DEFAULT_RATE_LIMIT, scope: 'process' },
      clock: frozenClock(10_000),
    });
    expect(limiter.headers(decision)).toEqual(rateLimitHeaders(decision, 10_000));
  });
});

describe('publishRateLimit', () => {
  const ctx = () =>
    createRequestContext({
      url: new URL('https://app.test/api/x'),
      method: 'POST',
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
  const with_ = (remaining: number, allowed = true): RateLimitDecision => ({
    ...decision,
    remaining,
    allowed,
    retryAfterSeconds: allowed ? 0 : 7,
  });

  test('the bucket closest to refusing is the one answered', () => {
    const request = ctx();
    publishRateLimit(request, with_(1), 10_000);
    publishRateLimit(request, with_(4), 10_000);
    expect(request.rateLimit?.remaining).toBe(1);
    expect(request.headers.get('ratelimit-remaining')).toBe('1');
    publishRateLimit(request, with_(0), 10_000);
    expect(request.headers.get('ratelimit-remaining')).toBe('0');
  });

  test('a refusal always wins, so the 429 carries its own Retry-After', () => {
    const request = ctx();
    publishRateLimit(request, with_(0), 10_000);
    publishRateLimit(request, with_(2, false), 10_000);
    expect(request.rateLimit?.retryAfterSeconds).toBe(7);
  });
});
