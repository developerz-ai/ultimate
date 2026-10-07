// An address that has spent its failed-credential allowance is refused BEFORE `authenticate()`
// runs on a required route. Spending only after the fact turned a wrong guess into a 429 and still
// let a right one through, so the meter bounded nothing a guesser cares about.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore, type RateLimitStore, rateLimiter } from './rate-limit';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/private',
    meta: { name: 'private', auth: 'required' },
    handler: () => textResponse('ok'),
  },
  {
    method: 'GET',
    path: '/public',
    meta: { name: 'public', auth: 'public' },
    handler: () => textResponse('ok'),
  },
];

/** Capacity 3, one token back every 10 s; `lookups` counts every credential-store read. */
const metered = () => {
  const counter = { lookups: 0 };
  const clock = frozenClock(1_700_000_000_000);
  const config = defineHttpConfig({
    dev: false,
    buildId: null,
    rateLimit: { scope: 'process', buckets: { default: { capacity: 3, refillPerSecond: 0.1 } } },
  });
  const pipeline = httpPipeline({
    table: httpRouter(routes),
    config,
    limiter: rateLimiter({ config: config.rateLimit, clock }),
    hooks: {
      authenticate: (request) => {
        counter.lookups += 1;
        return request.header('authorization') === 'Bearer right' ? ({ id: 'u1' } as never) : null;
      },
    },
  });
  return { pipeline, clock, counter };
};

const ask = (
  pipeline: ReturnType<typeof httpPipeline>,
  token: string,
  ip: string | null = '203.0.113.9',
  path = '/private',
) =>
  pipeline.handle(
    new Request(`http://localhost${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    }),
    { role: 'web', ip },
  );

describe('a required route refuses an exhausted address before authenticate()', () => {
  test('a valid credential under the limit is served', async () => {
    const { pipeline } = metered();
    await ask(pipeline, 'wrong');
    await ask(pipeline, 'wrong');
    expect((await ask(pipeline, 'right')).status).toBe(200);
  });

  test('a valid credential with the bucket empty is refused 429, and the store is not asked', async () => {
    const { pipeline, counter } = metered();
    for (let index = 0; index < 3; index += 1) {
      expect((await ask(pipeline, 'wrong')).status).toBe(401);
    }
    const lookups = counter.lookups;
    const refused = await ask(pipeline, 'right');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await refused.json()) as { code: string }).code).toBe('X_RATE_LIMITED');
    expect(counter.lookups).toBe(lookups);
  });

  test('the window resetting lets the valid credential through again', async () => {
    const { pipeline, clock } = metered();
    for (let index = 0; index < 3; index += 1) await ask(pipeline, 'wrong');
    expect((await ask(pipeline, 'right')).status).toBe(429);
    clock.advance(10_000);
    expect((await ask(pipeline, 'right')).status).toBe(200);
  });

  test('another address and a public route are untouched by it', async () => {
    const { pipeline } = metered();
    for (let index = 0; index < 3; index += 1) await ask(pipeline, 'wrong');
    expect((await ask(pipeline, 'right', '198.51.100.4')).status).toBe(200);
    expect((await ask(pipeline, 'right', '203.0.113.9', '/public')).status).toBe(200);
  });

  test('with no address there is no key to refuse on, so a valid credential is served', async () => {
    const { pipeline } = metered();
    for (let index = 0; index < 4; index += 1) await ask(pipeline, 'wrong', null);
    expect((await ask(pipeline, 'right', null)).status).toBe(200);
  });
});

describe('the gate reads, it never writes', () => {
  test('N signed-in requests to a required route take nothing under the failure key', async () => {
    const backing = memoryRateLimitStore();
    const failureTakes: string[] = [];
    const peeks: string[] = [];
    const counting: RateLimitStore = {
      scope: backing.scope,
      take: (key, bucket, cost, nowMs) => {
        if (key.startsWith('unauthenticated|')) failureTakes.push(key);
        return backing.take(key, bucket, cost, nowMs);
      },
      peek: (key, bucket, nowMs) => {
        peeks.push(key);
        return backing.peek(key, bucket, nowMs);
      },
      reset: (key) => backing.reset(key),
    };
    const config = defineHttpConfig({
      dev: false,
      buildId: null,
      rateLimit: { scope: 'process', buckets: { default: { capacity: 100, refillPerSecond: 1 } } },
    });
    const pipeline = httpPipeline({
      table: httpRouter(routes),
      config,
      limiter: rateLimiter({ config: config.rateLimit, store: counting }),
      hooks: { authenticate: () => ({ id: 'u1' }) as never },
    });
    for (let index = 0; index < 10; index += 1) {
      expect((await ask(pipeline, 'right')).status).toBe(200);
    }
    expect(failureTakes).toEqual([]);
    expect(peeks).toHaveLength(10);
  });
});
