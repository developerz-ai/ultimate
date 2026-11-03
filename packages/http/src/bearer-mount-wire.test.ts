// What a bearer mount says on the wire about its own door: the allowance it declares is the ceiling
// (never `default`'s 120), and a successor link names a URL this caller can follow, or nothing.

import { describe, expect, test } from 'bun:test';
import {
  type Actor,
  agentActor,
  frozenClock,
  renderDeprecation,
  UltimateError,
} from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { bearerMount } from './bearer-mount';
import { defineHttpConfig } from './config';
import { useRequestContext } from './context';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore, rateLimiter } from './rate-limit';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const agent: Actor = agentActor({ id: 'user_1', orgId: 'org_1' });

const WINDOW = { since: '2026-01-01T00:00:00Z', sunset: '2027-01-01T00:00:00Z' };

/** The headers `@ultimat3/action`'s and `@ultimat3/query`'s projections set, on the context. */
const announceSuccessor = (served: string): void => {
  const rendered = renderDeprecation(WINDOW, served);
  if (!rendered.ok) {
    expect.unreachable('the fixture window is a real date');
    return;
  }
  const ctx = useRequestContext();
  for (const [name, value] of Object.entries(rendered.headers)) ctx?.headers.set(name, value);
};

const deprecated = (name: string, successor: string): Route => ({
  method: 'POST',
  path: `/api/${name}`,
  meta: { name, auth: 'required', enforcedBy: 'handler' },
  handler: () => {
    announceSuccessor(successor);
    return jsonResponse({ ok: true });
  },
});

const refused = (name: string, successor: string): Route => ({
  method: 'POST',
  path: `/api/${name}`,
  meta: { name, auth: 'required', enforcedBy: 'handler' },
  handler: () => {
    announceSuccessor(successor);
    throw new UltimateError({ code: 'X_FORBIDDEN', cause: 'policy said no', fix: 'ask an owner' });
  },
});

const plain = (name: string, meta: Partial<Route['meta']> = {}): Route => ({
  method: 'POST',
  path: `/api/${name}`,
  meta: { name, auth: 'required', enforcedBy: 'handler', ...meta },
  handler: () => jsonResponse({ ok: true }),
});

const routes: readonly Route[] = [
  plain('hot'),
  plain('new-case'),
  plain('admin-case'),
  plain('outside'),
  deprecated('old-case', '/api/new-case'),
  deprecated('old-gone', '/api/outside'),
  deprecated('old-hidden', '/api/admin-case'),
  refused('old-refused', '/api/new-case'),
  refused('gone-refused', '/api/outside'),
  {
    method: 'POST',
    path: '/api/paged',
    meta: { name: 'paged', auth: 'required', enforcedBy: 'handler' },
    handler: () => {
      useRequestContext()?.headers.set('link', '</api/paged?page=2>; rel="next"');
      return jsonResponse({ ok: true });
    },
  },
];

const SCOPES = {
  write: [
    'hot',
    'new-case',
    'old-case',
    'old-gone',
    'old-hidden',
    'old-refused',
    'gone-refused',
    'paged',
  ],
  admin: ['admin-case'],
};

const pipelineFor = (limit?: number, extra: readonly Route[] = []) => {
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
  const mounted = bearerMount({
    prefix: '/v1',
    routes: [...routes, ...extra],
    scopes: { ...SCOPES, ...(extra.length === 0 ? {} : { extra: extra.map((r) => r.meta.name) }) },
    resolveToken: (token) =>
      token === 'tok' ? { actor: agent, scopes: new Set(['write', 'extra']) } : null,
    ...(limit === undefined ? {} : { rateLimit: { limit, windowMs: 60_000 } }),
    rateLimitStore: memoryRateLimitStore(),
    clock: frozenClock(0),
  });
  return httpPipeline({
    table: httpRouter([...routes, ...extra, ...mounted]),
    config,
    // Frozen, so `default`'s refill cannot hand a slow runner a 121st token.
    limiter: rateLimiter({ config: config.rateLimit, clock: frozenClock(0) }),
    hooks: { authenticate: () => agent },
  });
};

type Pipeline = ReturnType<typeof pipelineFor>;

const post = (pipeline: Pipeline, path: string): Promise<Response | undefined> =>
  pipeline.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: '{}',
    }),
    { role: 'web' },
  );

/** Calls until the first refusal: how many were admitted, and the refusal itself. */
async function admittedBeforeRefusal(pipeline: Pipeline, ceiling: number) {
  for (let admitted = 0; admitted <= ceiling; admitted += 1) {
    const response = await post(pipeline, '/v1/hot');
    if (response?.status !== 200) return { admitted, response };
  }
  return expect.unreachable(`no refusal within ${ceiling} calls`);
}

describe('the mount allowance replaces default', () => {
  test('a limit of 1000 admits 1000 calls, and the 1001st is the mount 429', async () => {
    const { admitted, response } = await admittedBeforeRefusal(pipelineFor(1000), 1100);
    expect(admitted).toBe(1000);
    expect(response?.status).toBe(429);
    // The mount's own bucket refused: `default` would report 120.
    expect(response?.headers.get('ratelimit-limit')).toBe('1000');
    const body = (await response?.json()) as { meta?: unknown; code: string };
    expect(body.code).toBe('X_RATE_LIMITED');
  });

  test('a mount declaring no rateLimit keeps default: the 121st call is refused', async () => {
    const { admitted, response } = await admittedBeforeRefusal(pipelineFor(), 200);
    expect(admitted).toBe(120);
    expect(response?.status).toBe(429);
    expect(response?.headers.get('ratelimit-limit')).toBe('120');
  });

  test('a route naming its own bucket keeps spending it under the mount', async () => {
    const hot = plain('named', { rateLimit: 'tight' });
    const config = defineHttpConfig({
      dev: false,
      rateLimit: {
        scope: 'process',
        buckets: { tight: { capacity: 2, refillPerSecond: 0.000_1 } },
      },
    });
    const mounted = bearerMount({
      prefix: '/v1',
      routes: [hot],
      scopes: { write: ['named'] },
      resolveToken: () => ({ actor: agent, scopes: new Set(['write']) }),
      rateLimit: { limit: 1000, windowMs: 60_000 },
      rateLimitStore: memoryRateLimitStore(),
      clock: frozenClock(0),
    });
    const pipeline = httpPipeline({
      table: httpRouter([hot, ...mounted]),
      config,
      limiter: rateLimiter({ config: config.rateLimit, clock: frozenClock(0) }),
      hooks: { authenticate: () => agent },
    });
    const statuses: (number | undefined)[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await post(pipeline, '/v1/named'))?.status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('every refusal on the mount states its retry class', () => {
  const bodyOf = async (response: Response | undefined) =>
    (await response?.json()) as { retry?: unknown };

  test('a 401, which leaves in the auth stage', async () => {
    const response = await pipelineFor().handle(
      new Request('http://localhost/v1/hot', { method: 'POST', body: '{}' }),
      { role: 'web' },
    );
    expect(response?.status).toBe(401);
    expect((await bodyOf(response)).retry).toBe('terminal');
  });

  test('a scope 404, which leaves in the auth stage too', async () => {
    const response = await post(pipelineFor(), '/v1/admin-case');
    expect(response?.status).toBe(404);
    expect((await bodyOf(response)).retry).toBe('terminal');
  });

  test('the mount 429', async () => {
    const { response } = await admittedBeforeRefusal(pipelineFor(1), 5);
    expect(response?.status).toBe(429);
    expect((await bodyOf(response)).retry).toBe('retry-after');
  });
});

describe('a successor link on the mount', () => {
  test('names the mounted path when the successor is in the cut', async () => {
    const response = await post(pipelineFor(), '/v1/old-case');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('link')).toBe('</v1/new-case>; rel="successor-version"');
    expect(response?.headers.get('deprecation')).not.toBeNull();
    expect(response?.headers.get('sunset')).not.toBeNull();
  });

  test('is absent when the successor is outside the cut', async () => {
    const response = await post(pipelineFor(), '/v1/old-gone');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('link')).toBeNull();
    expect(response?.headers.get('deprecation')).not.toBeNull();
  });

  test('is absent when this token does not hold the scope that reaches it', async () => {
    // Naming it would confirm a primitive the mount answers 404 for: the catalog's hidden-tool rule.
    const response = await post(pipelineFor(), '/v1/old-hidden');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('link')).toBeNull();
  });

  test('is rewritten on a refusal too', async () => {
    const response = await post(pipelineFor(), '/v1/old-refused');
    expect(response?.status).toBe(403);
    expect(response?.headers.get('link')).toBe('</v1/new-case>; rel="successor-version"');
  });

  test('is absent on a refusal when the successor is outside the cut', async () => {
    const response = await post(pipelineFor(), '/v1/gone-refused');
    expect(response?.status).toBe(403);
    expect(response?.headers.get('link')).toBeNull();
    expect(response?.headers.get('deprecation')).not.toBeNull();
  });

  test('a link of any other relation is the handler own, and is left alone', async () => {
    const response = await post(pipelineFor(), '/v1/paged');
    expect(response?.headers.get('link')).toBe('</api/paged?page=2>; rel="next"');
  });

  test('the cookie door still names the cookie door', async () => {
    const response = await post(pipelineFor(), '/api/old-case');
    expect(response?.headers.get('link')).toBe('</api/new-case>; rel="successor-version"');
  });
});

describe('every request through the mount pays once, refused before the handler or not', () => {
  const guarded: readonly Route[] = [
    plain('rename', { input: t.object({ title: t.string }) }),
    { ...plain('close'), meta: { name: 'close', auth: 'required', policy: 'case:close' } },
  ];
  const pipeline = () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
    return httpPipeline({
      table: httpRouter(
        bearerMount({
          prefix: '/v1',
          routes: guarded,
          scopes: { write: ['rename', 'close'] },
          resolveToken: () => ({ actor: agent, scopes: new Set(['write']) }),
          rateLimit: { limit: 2, windowMs: 60_000 },
          rateLimitStore: memoryRateLimitStore(),
          clock: frozenClock(0),
        }),
      ),
      config,
      limiter: rateLimiter({ config: config.rateLimit, clock: frozenClock(0) }),
      hooks: { authorize: () => ({ allowed: false, reason: 'closed by the owner' }) },
    });
  };
  const statuses = async (path: string) => {
    const mounted = pipeline();
    const out: (number | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) out.push((await post(mounted, path))?.status);
    return out;
  };

  test('an invalid body spends the allowance: the third is 429, not a third 422', async () => {
    expect(await statuses('/v1/rename')).toEqual([422, 422, 429, 429]);
  });

  test('a pipeline denial spends it too', async () => {
    expect(await statuses('/v1/close')).toEqual([403, 403, 429, 429]);
  });

  test('a served call is still charged exactly once', async () => {
    const mounted = pipelineFor(2);
    expect((await post(mounted, '/v1/hot'))?.headers.get('ratelimit-remaining')).toBe('1');
    expect((await post(mounted, '/v1/hot'))?.headers.get('ratelimit-remaining')).toBe('0');
    expect((await post(mounted, '/v1/hot'))?.status).toBe(429);
  });
});
