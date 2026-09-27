// The bearer mount, through the whole pipeline: only the token authenticates, the cut hides what
// a token was not issued for, and the per-token allowance answers 429 with Retry-After.

import { describe, expect, test } from 'bun:test';
import { type Actor, agentActor, frozenClock, userActor } from '@ultimat3/core';
import { bearerMount, bearerTokenOf, mountedPath } from './bearer-mount';
import { defineHttpConfig } from './config';
import { useRequestContext } from './context';
import { createPipeline } from './pipeline';
import { memoryRateLimitStore } from './rate-limit';
import { json } from './response';
import { createRouter, type Route } from './router';

const agent: Actor = agentActor({ id: 'user_1', orgId: 'org_1' });

const seenActor = (): Response => json({ actor: useRequestContext()?.actor.id ?? null });

const api: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/create-case',
    meta: { name: 'createCase', auth: 'required', enforcedBy: 'handler' },
    handler: seenActor,
  },
  {
    method: 'GET',
    path: '/_x/query/case-list',
    meta: { name: 'caseList', auth: 'required', enforcedBy: 'handler' },
    handler: seenActor,
  },
  {
    method: 'POST',
    path: '/api/grant-credits',
    meta: { name: 'grantCredits', auth: 'required', enforcedBy: 'handler' },
    handler: seenActor,
  },
];

const TOKENS: Readonly<Record<string, readonly string[]>> = {
  'tok-read': ['cases:read'],
  'tok-write': ['cases:read', 'cases:write'],
};

const pipelineFor = (limit?: number) => {
  const mounted = bearerMount({
    prefix: '/v1',
    routes: api,
    scopes: { 'cases:read': ['caseList'], 'cases:write': ['createCase'] },
    resolveToken: (token) => {
      const scopes = TOKENS[token];
      return scopes === undefined ? null : { actor: agent, scopes: new Set(scopes) };
    },
    ...(limit === undefined ? {} : { rateLimit: { limit, windowMs: 60_000 } }),
    rateLimitStore: memoryRateLimitStore(),
    clock: frozenClock(0),
  });
  return createPipeline({
    table: createRouter([...api, ...mounted]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    hooks: {
      // The app's cookie authenticator: it must never be consulted on the mount.
      authenticate: (request) =>
        request.header('cookie') === 'session=ok' ? userActor({ id: 'cookie_user' }) : null,
    },
  });
};

const call = (method: string, path: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

describe('mountedPath', () => {
  test('replaces the framework namespace with the prefix', () => {
    expect(mountedPath('/v1', '/api/create-case')).toBe('/v1/create-case');
    expect(mountedPath('/v1', '/_x/query/case-list')).toBe('/v1/case-list');
    expect(mountedPath('/v1', '/webhooks/x')).toBe('/v1/webhooks/x');
  });
});

describe('bearerTokenOf', () => {
  test('reads only the Bearer scheme', () => {
    expect(bearerTokenOf('Bearer abc')).toBe('abc');
    expect(bearerTokenOf('bearer abc')).toBe('abc');
    expect(bearerTokenOf('Basic abc')).toBeNull();
    expect(bearerTokenOf(null)).toBeNull();
  });
});

describe('bearerMount through the pipeline', () => {
  test('a token in scope reaches the same handler, as the token actor', async () => {
    const response = await pipelineFor().handle(
      call('POST', '/v1/create-case', { authorization: 'Bearer tok-write' }),
      { role: 'web' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actor: 'user_1' });
    const read = await pipelineFor().handle(
      call('GET', '/v1/case-list', { authorization: 'Bearer tok-read' }),
      { role: 'web' },
    );
    expect(read.status).toBe(200);
  });

  test('no token is 401 with WWW-Authenticate: Bearer', async () => {
    const response = await pipelineFor().handle(call('GET', '/v1/case-list'), { role: 'web' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('an unknown, revoked or expired token is 401 invalid_token', async () => {
    const response = await pipelineFor().handle(
      call('GET', '/v1/case-list', { authorization: 'Bearer revoked' }),
      { role: 'web' },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  test('a session cookie authenticates NOTHING on the mount, and needs no CSRF proof there', async () => {
    const response = await pipelineFor().handle(
      call('POST', '/v1/create-case', { cookie: 'session=ok', origin: 'https://evil.test' }),
      { role: 'web' },
    );
    expect(response.status).toBe(401);
    // …while the cookie still works on the app's own /api route, which the mount leaves alone.
    const api = await pipelineFor().handle(
      call('POST', '/api/create-case', { cookie: 'session=ok', 'sec-fetch-site': 'same-origin' }),
      { role: 'web' },
    );
    expect(await api.json()).toEqual({ actor: 'cookie_user' });
  });

  test('a bearer POST from another origin is not a CSRF refusal', async () => {
    const response = await pipelineFor().handle(
      call('POST', '/v1/create-case', {
        authorization: 'Bearer tok-write',
        origin: 'https://integrator.example',
      }),
      { role: 'web' },
    );
    expect(response.status).toBe(200);
  });

  test('a primitive outside the token scopes is 404, exactly like an unknown path', async () => {
    const hidden = await pipelineFor().handle(
      call('POST', '/v1/create-case', { authorization: 'Bearer tok-read' }),
      { role: 'web' },
    );
    const unknown = await pipelineFor().handle(
      call('POST', '/v1/grant-credits', { authorization: 'Bearer tok-write' }),
      { role: 'web' },
    );
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(((await hidden.json()) as { code: string }).code).toBe('X_ROUTE_NOT_FOUND');
    expect(((await unknown.json()) as { code: string }).code).toBe('X_ROUTE_NOT_FOUND');
  });

  test('the per-token allowance answers RateLimit-* and a 429 with Retry-After', async () => {
    const pipeline = pipelineFor(2);
    const send = () =>
      pipeline.handle(call('GET', '/v1/case-list', { authorization: 'Bearer tok-read' }), {
        role: 'web',
      });
    const first = await send();
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    await send();
    const third = await send();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(third.headers.get('ratelimit-remaining')).toBe('0');
    // Another token has its own allowance.
    const other = await pipeline.handle(
      call('GET', '/v1/case-list', { authorization: 'Bearer tok-write' }),
      { role: 'web' },
    );
    expect(other.status).toBe(200);
  });
});

describe('bearerMount refuses at construction', () => {
  const base = {
    routes: api,
    scopes: { 'cases:read': ['caseList'] },
    resolveToken: () => null,
  };
  test.each([['/api'], ['/api/v1'], ['/_x/v1'], ['v1'], ['/V1'], ['/v1/']])(
    'prefix %s',
    (prefix) => {
      expect(() => bearerMount({ ...base, prefix })).toThrow(
        expect.objectContaining({ code: 'X_BEARER_MOUNT_INVALID' }),
      );
    },
  );

  test('a scope naming a primitive no route carries', () => {
    expect(() =>
      bearerMount({ ...base, prefix: '/v1', scopes: { 'cases:read': ['caseLsit'] } }),
    ).toThrow(expect.objectContaining({ code: 'X_BEARER_MOUNT_INVALID' }));
  });

  test('one primitive claimed by two scopes', () => {
    expect(() =>
      bearerMount({
        ...base,
        prefix: '/v1',
        scopes: { 'cases:read': ['caseList'], 'cases:write': ['caseList'] },
      }),
    ).toThrow(expect.objectContaining({ code: 'X_BEARER_MOUNT_INVALID' }));
  });
});
