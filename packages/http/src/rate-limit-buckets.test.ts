// Registration and its refusal: a route's numbers reach the limiter's table, and two
// declarations of one bucket stop the process instead of one of them quietly winning.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import type { HttpError } from './errors';
import { createPipeline } from './pipeline';
import { type Bucket, memoryRateLimitStore } from './rate-limit';
import { withRouteBuckets } from './rate-limit-buckets';
import { createRouter, type Route } from './router';
import { createServer } from './server';

const ok = (): Response => new Response('ok');

const route = (name: string, bucket?: Bucket): Route => ({
  method: 'POST',
  path: `/api/${name}`,
  handler: ok,
  meta: {
    name,
    auth: 'public',
    ...(bucket === undefined ? {} : { rateLimit: name, rateLimitBucket: bucket }),
  },
});

const TIGHT: Bucket = { capacity: 5, refillPerSecond: 0.008 };

describe('withRouteBuckets', () => {
  test('registers a route-declared bucket under the name the route selects', () => {
    const merged = withRouteBuckets(defineHttpConfig(), [route('contactSales', TIGHT)]);
    expect(merged.rateLimit.buckets['contactSales']).toEqual(TIGHT);
    // The table it came from is untouched — every other bucket still resolves.
    expect(merged.rateLimit.buckets['default']).toEqual({ capacity: 120, refillPerSecond: 2 });
  });

  test('a route that declares nothing leaves the config identical', () => {
    const config = defineHttpConfig();
    expect(withRouteBuckets(config, [route('listPosts')])).toBe(config);
  });

  test('applying it twice changes nothing — both construction paths may run it', () => {
    const once = withRouteBuckets(defineHttpConfig(), [route('contactSales', TIGHT)]);
    const twice = withRouteBuckets(once, [route('contactSales', TIGHT)]);
    expect(twice.rateLimit.buckets).toEqual(once.rateLimit.buckets);
  });

  test('a configured bucket saying the same thing is accepted, not a conflict', () => {
    const config = defineHttpConfig({ rateLimit: { buckets: { contactSales: TIGHT } } });
    expect(() => withRouteBuckets(config, [route('contactSales', TIGHT)])).not.toThrow();
  });

  test('a configured bucket saying something else is refused, with both numbers named', () => {
    const config = defineHttpConfig({
      rateLimit: { buckets: { contactSales: { capacity: 120, refillPerSecond: 2 } } },
    });
    const error = (() => {
      try {
        withRouteBuckets(config, [route('contactSales', TIGHT)]);
        return null;
      } catch (thrown) {
        return thrown as HttpError;
      }
    })();
    expect(error?.code).toBe('X_RATE_LIMIT_BUCKET_CONFLICT');
    expect(error?.cause).toContain('120 / 2');
    expect(error?.cause).toContain('5 / 0.008');
    // Axiom 4: the fix is the edit, naming the key to delete rather than "resolve the conflict".
    expect(error?.fix).toContain('delete http.rateLimit.buckets.contactSales');
  });

  test('two routes claiming one bucket with different numbers are refused', () => {
    const routes = [
      route('contactSales', TIGHT),
      {
        ...route('other'),
        meta: {
          ...route('other').meta,
          rateLimit: 'contactSales',
          rateLimitBucket: { capacity: 9, refillPerSecond: 1 },
        },
      },
    ];
    expect(() => withRouteBuckets(defineHttpConfig(), routes)).toThrow(
      /X_RATE_LIMIT_BUCKET_CONFLICT/,
    );
  });

  // Run, never reasoned about: `createServer` merges and `createPipeline` merges again under it,
  // so the second pass is proven a no-op by comparing the two resolved tables — not by trusting
  // that `same()` says so.
  test('the second pass over an already-merged config changes nothing', () => {
    const server = createServer({ routes: [route('contactSales', TIGHT)] });
    expect(server.config.rateLimit.buckets['contactSales']).toEqual(TIGHT);
    expect(server.pipeline.config.rateLimit.buckets).toEqual(server.config.rateLimit.buckets);
  });

  // The reason `createServer` merges at all: the store-backed limiter is built there, from
  // `config.rateLimit`. An unmerged table would resolve `contactSales` to `default` — 120 burst.
  test('a store-backed limiter enforces the route bucket, not the default', async () => {
    const server = createServer({
      routes: [route('contactSales', TIGHT)],
      rateLimitStore: memoryRateLimitStore(),
    });
    const call = (): Promise<Response> =>
      server.fetch(new Request('http://dev.test/api/contactSales', { method: 'POST' }));
    expect((await call()).headers.get('ratelimit-limit')).toBe('5');
    for (let i = 0; i < 4; i += 1) await call();
    expect((await call()).status).toBe(429);
  });

  test('the pipeline enforces the registered bucket, not the default one', async () => {
    const pipeline = createPipeline({ table: createRouter([route('contactSales', TIGHT)]) });
    const call = (): Promise<Response> =>
      pipeline.handle(new Request('http://dev.test/api/contactSales', { method: 'POST' }), {
        role: 'web',
      });
    const first = await call();
    expect(first.headers.get('ratelimit-limit')).toBe('5');
    for (let i = 0; i < 4; i += 1) await call();
    expect((await call()).status).toBe(429);
  });
});
