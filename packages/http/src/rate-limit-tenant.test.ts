// Single responsibility: the bucket a whole TENANT spends, through the pipeline that spends it.
// Split from `rate-limit.test.ts` because that file asks about the maths and the key strings; this
// one asks whether two different actors in one org can exhaust one allowance between them.
//
// The failure it pins: `rateLimitKey` was `actor > org > ip`, EXCLUSIVE — an authenticated request
// never touched an org bucket, so a tenant with 8,000 seats whose integration entered a retry loop
// took 8,000 × the per-actor burst against one shared pool, and no number an operator could set
// anywhere would have throttled it.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { text } from './response';
import { createRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/posts',
    meta: { name: 'posts.list', auth: 'public' },
    handler: () => text('ok'),
  },
];

const actor = (id: string, orgId: string): Actor =>
  ({ kind: 'user', id, orgId, roles: [], scopes: [] }) as unknown as Actor;

/** A generous per-actor bucket and a tight tenant one: only the tenant cap can refuse here. */
const pipelineFor = (who: () => Actor): ReturnType<typeof createPipeline> =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({
      dev: false,
      buildId: null,
      rateLimit: {
        scope: 'process',
        defaultBucket: 'default',
        tenantBucket: 'tenant',
        buckets: {
          default: { capacity: 100, refillPerSecond: 0.001 },
          tenant: { capacity: 3, refillPerSecond: 0.001 },
        },
      },
    }),
    hooks: { authenticate: () => who() },
  });

describe('the tenant bucket is spent beside the actor bucket', () => {
  test('two actors in one org exhaust the org allowance between them', async () => {
    let next = 0;
    // Alternating actors, so neither one's own bucket (100) is anywhere near empty.
    const pipeline = pipelineFor(() => actor(`u${String(next++ % 2)}`, 'acme'));
    const statuses: number[] = [];
    for (let call = 0; call < 4; call += 1) {
      const response = await pipeline.handle(new Request('http://localhost/posts'), {
        role: 'web',
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  test('another tenant is untouched by the first one exhausting its bucket', async () => {
    const acme = pipelineFor(() => actor('u1', 'acme'));
    for (let call = 0; call < 4; call += 1) {
      await acme.handle(new Request('http://localhost/posts'), { role: 'web' });
    }
    const other = await pipelineFor(() => actor('u9', 'globex')).handle(
      new Request('http://localhost/posts'),
      { role: 'web' },
    );
    expect(other.status).toBe(200);
  });

  test('with no tenant bucket declared nothing changes for the same traffic', async () => {
    const pipeline = createPipeline({
      table: createRouter(routes),
      config: defineHttpConfig({
        dev: false,
        buildId: null,
        rateLimit: {
          scope: 'process',
          buckets: { default: { capacity: 100, refillPerSecond: 0.001 } },
        },
      }),
      hooks: { authenticate: () => actor('u1', 'acme') },
    });
    const statuses: number[] = [];
    for (let call = 0; call < 4; call += 1) {
      const response = await pipeline.handle(new Request('http://localhost/posts'), {
        role: 'web',
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  test('the headers report the bucket that is closest to refusing, not the last one spent', async () => {
    const response = await pipelineFor(() => actor('u1', 'acme')).handle(
      new Request('http://localhost/posts'),
      { role: 'web' },
    );
    // The tenant bucket holds 3 and the actor's 100 — a caller told `ratelimit-remaining: 99`
    // would plan against an allowance that refuses it on the third call.
    expect(response.headers.get('ratelimit-limit')).toBe('3');
    expect(response.headers.get('ratelimit-remaining')).toBe('2');
  });
});

describe('a tenant bucket names a bucket that exists', () => {
  test('a name nothing declares is refused at defineHttpConfig, never at the first request', () => {
    expect(() =>
      defineHttpConfig({
        rateLimit: {
          scope: 'process',
          tenantBucket: 'fleet',
          buckets: { default: { capacity: 10, refillPerSecond: 1 } },
        },
      }),
    ).toThrow(/X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN/);
  });
});
