// Single responsibility: a route whose OWN limit is spent by its handler (`rateLimitedBy:
// 'handler'` — every action and query route) is not also capped by the `default` bucket. The
// primitive spends its declared bucket on every surface; the stage spending `default` beside it
// would put a 120-burst ceiling on an action that declared 1,000, which it never had.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { rateLimitSpends } from './rate-limit';
import { text } from './response';
import { createRouter, type Route } from './router';

const route = (rateLimitedBy?: 'handler'): Route => ({
  method: 'GET',
  path: '/search',
  meta: {
    name: 'search',
    auth: 'public',
    ...(rateLimitedBy === undefined ? {} : { rateLimitedBy }),
  },
  handler: () => text('ok'),
});

const actor = (id: string, orgId: string): Actor =>
  ({ kind: 'user', id, orgId, roles: [], scopes: [] }) as unknown as Actor;

/** `default` holds two and never refills; the tenant one is generous, or tight when asked. */
const pipelineFor = (target: Route, tenantCapacity = 100) =>
  createPipeline({
    table: createRouter([target]),
    config: defineHttpConfig({
      dev: false,
      buildId: null,
      rateLimit: {
        scope: 'process',
        defaultBucket: 'default',
        tenantBucket: 'tenant',
        buckets: {
          default: { capacity: 2, refillPerSecond: 0.000_1 },
          tenant: { capacity: tenantCapacity, refillPerSecond: 0.000_1 },
        },
      },
    }),
    hooks: { authenticate: () => actor('u1', 'acme') },
  });

async function statuses(pipeline: ReturnType<typeof pipelineFor>, count: number) {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      (await pipeline.handle(new Request('http://localhost/search'), { role: 'web' })).status,
    );
  }
  return out;
}

describe('a route its handler rate-limits', () => {
  test('a plain route is capped by default — the control', async () => {
    expect(await statuses(pipelineFor(route()), 3)).toEqual([200, 200, 429]);
  });

  test('a handler-limited route is not capped by default', async () => {
    expect(await statuses(pipelineFor(route('handler')), 5)).toEqual([200, 200, 200, 200, 200]);
  });

  test('the tenant allowance still applies to it', async () => {
    expect(await statuses(pipelineFor(route('handler'), 3), 4)).toEqual([200, 200, 200, 429]);
  });

  test('the decision is one function: no route bucket, only the tenant spend', () => {
    const parts = { actorId: 'u1', orgId: 'acme', ip: null, routeName: 'search' };
    expect(rateLimitSpends(parts, { route: null, tenant: 'tenant' })).toEqual([
      { key: 'tenant|org:acme', bucket: 'tenant' },
    ]);
    expect(rateLimitSpends(parts, { route: null, tenant: null })).toEqual([]);
  });

  test('an unattributed subject is the caller’s to name — never forced onto ip:unknown', () => {
    const nobody = { actorId: null, orgId: null, ip: null, routeName: 'r' };
    expect(rateLimitSpends(nobody, { route: 'b', tenant: null })[0]?.key).toBe('r|ip:unknown');
    expect(
      rateLimitSpends(
        { ...nobody, unattributed: 'job:unattributed' },
        { route: 'b', tenant: null },
      )[0]?.key,
    ).toBe('r|job:unattributed');
  });
});
