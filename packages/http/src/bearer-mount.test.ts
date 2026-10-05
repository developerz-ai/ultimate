// The bearer mount, through the whole pipeline: only the token authenticates, the cut hides what
// a token was not issued for, and the per-token allowance answers 429 with Retry-After.

import { describe, expect, test } from 'bun:test';
import { type Actor, agentActor, frozenClock, userActor } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
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

// Whether a path is served must not be readable without a token. The mount answered 401 on a
// served path and 404 (or 405, for a served path under another method) everywhere else, so an
// anonymous walk of `/v1/*` listed the cut. Under the prefix every anonymous request is now the
// same 401 challenge, and every authenticated miss the same 404.
describe('the prefix is opaque to a caller without a valid token', () => {
  const answer = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const response = await pipelineFor().handle(call(method, path, headers), { role: 'web' });
    const body = (await response.json()) as { code?: string };
    return {
      status: response.status,
      challenge: response.headers.get('www-authenticate'),
      allow: response.headers.get('allow'),
      code: body.code,
    };
  };

  test('no token: a served path, an unserved one and a wrong method answer alike', async () => {
    const served = await answer('POST', '/v1/create-case');
    expect(served).toEqual({
      status: 401,
      challenge: 'Bearer',
      allow: null,
      code: 'X_UNAUTHENTICATED',
    });
    // `grantCredits` is a real route the cut leaves out; `nothing` is no route at all.
    expect(await answer('POST', '/v1/grant-credits')).toEqual(served);
    expect(await answer('POST', '/v1/nothing/at/all')).toEqual(served);
    expect(await answer('GET', '/v1/create-case')).toEqual(served);
    expect(await answer('DELETE', '/v1')).toEqual(served);
  });

  test('a bad token: the same invalid_token challenge, served or not', async () => {
    const bad = { authorization: 'Bearer revoked' };
    const served = await answer('GET', '/v1/case-list', bad);
    expect(served.status).toBe(401);
    expect(served.challenge).toBe('Bearer error="invalid_token"');
    expect(await answer('GET', '/v1/nothing', bad)).toEqual(served);
  });

  test('a valid token: an unserved path or method is the same 404 an out-of-scope one is', async () => {
    const auth = { authorization: 'Bearer tok-read' };
    const hidden = await answer('POST', '/v1/create-case', auth);
    expect(hidden.status).toBe(404);
    expect(hidden.code).toBe('X_ROUTE_NOT_FOUND');
    expect(await answer('POST', '/v1/nothing', auth)).toEqual(hidden);
    expect(await answer('PUT', '/v1/create-case', auth)).toEqual(hidden);
  });

  // The catch-all serves OPTIONS too, and a browser preflight carries no Authorization header —
  // a 401 there would block every cross-origin integrator. The `context` stage answers a preflight
  // before the match, so the catch-all never sees one.
  test('a CORS preflight under the prefix gets the CORS answer, never the 401', async () => {
    const pipeline = createPipeline({
      table: createRouter(
        bearerMount({
          prefix: '/v1',
          routes: api,
          scopes: { 'cases:read': ['caseList'] },
          resolveToken: () => null,
        }),
      ),
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        dev: false,
        cors: { origins: ['https://integrator.example'], credentials: false },
      }),
    });
    for (const path of ['/v1/case-list', '/v1/not-served']) {
      const response = await pipeline.handle(
        new Request(`http://localhost${path}`, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://integrator.example',
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'authorization',
          },
        }),
        { role: 'web' },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://integrator.example',
      );
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
  });

  test("the app's own routes outside the prefix are untouched", async () => {
    expect((await answer('GET', '/elsewhere')).code).toBe('X_ROUTE_NOT_FOUND');
  });
});

// The cut is the FIRST answer an out-of-scope token gets. Checked in the handler, it came after the
// `body` and `authz` stages: the token was told the schema's issues (422) or the policy's reason
// (403) for a primitive it must not learn exists. In the `auth` stage it answers before either.
describe('the cut answers before body validation and authz', () => {
  let authorized = 0;
  const guarded: readonly Route[] = [
    {
      method: 'POST',
      path: '/api/rename-case',
      meta: { name: 'renameCase', auth: 'required', input: t.object({ title: t.string }) },
      handler: seenActor,
    },
    {
      method: 'POST',
      path: '/api/close-case',
      meta: { name: 'closeCase', auth: 'required', policy: 'case:close' },
      handler: seenActor,
    },
  ];
  const pipeline = () =>
    createPipeline({
      table: createRouter(
        bearerMount({
          prefix: '/v1',
          routes: [...api, ...guarded],
          scopes: { 'cases:read': ['caseList'], 'cases:write': ['renameCase', 'closeCase'] },
          resolveToken: (token) => {
            const scopes = TOKENS[token];
            return scopes === undefined ? null : { actor: agent, scopes: new Set(scopes) };
          },
        }),
      ),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
      hooks: {
        authorize: () => {
          authorized += 1;
          return { allowed: false, reason: 'cases are closed by their owner' };
        },
      },
    });

  test('an out-of-scope token is 404 even with an invalid body or a denying policy', async () => {
    authorized = 0;
    const invalidBody = await pipeline().handle(
      call('POST', '/v1/rename-case', { authorization: 'Bearer tok-read' }),
      { role: 'web' },
    );
    const denied = await pipeline().handle(
      call('POST', '/v1/close-case', { authorization: 'Bearer tok-read' }),
      { role: 'web' },
    );
    expect(invalidBody.status).toBe(404);
    expect(denied.status).toBe(404);
    expect(((await invalidBody.json()) as { code: string }).code).toBe('X_ROUTE_NOT_FOUND');
    const body = await denied.text();
    expect(body).toContain('X_ROUTE_NOT_FOUND');
    expect(body).not.toContain('cases are closed');
    // The policy was never asked: a refusal must not be decided by evaluating it.
    expect(authorized).toBe(0);
  });

  test('the same requests with the scope held reach the stages the cut sits in front of', async () => {
    authorized = 0;
    const invalidBody = await pipeline().handle(
      call('POST', '/v1/rename-case', { authorization: 'Bearer tok-write' }),
      { role: 'web' },
    );
    const denied = await pipeline().handle(
      call('POST', '/v1/close-case', { authorization: 'Bearer tok-write' }),
      { role: 'web' },
    );
    expect(invalidBody.status).toBe(422);
    expect(denied.status).toBe(403);
    expect(authorized).toBe(1);
  });
});

// A token that resolves to nobody never reaches the per-token allowance — there is no token to
// key it on — so guessing tokens on the mount was unmetered. The `auth` stage's failure path
// spends the address's allowance for it, as it does for every required route.
describe('a bad token on the mount is metered by address', () => {
  const guarded = () =>
    createPipeline({
      table: createRouter([
        ...api,
        ...bearerMount({
          prefix: '/v1',
          routes: api,
          scopes: { 'cases:read': ['caseList'] },
          resolveToken: (token) =>
            token === 'tok-read' ? { actor: agent, scopes: new Set(['cases:read']) } : null,
        }),
      ]),
      config: defineHttpConfig({
        dev: false,
        rateLimit: {
          scope: 'process',
          buckets: { default: { capacity: 3, refillPerSecond: 0.001 } },
        },
      }),
    });

  test('the fourth guess from one address is 429, a real token from it too, and from elsewhere is served', async () => {
    const pipeline = guarded();
    const guess = (index: number) =>
      pipeline.handle(call('GET', '/v1/case-list', { authorization: `Bearer guess-${index}` }), {
        role: 'web',
        ip: '203.0.113.9',
      });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) statuses.push((await guess(index)).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // No token at all is the same failure, and spends the same allowance.
    const bare = await pipeline.handle(call('GET', '/v1/case-list'), {
      role: 'web',
      ip: '203.0.113.9',
    });
    expect(bare.status).toBe(429);
    // A right guess from the spent address is refused before the token is resolved: otherwise
    // the 429 told a wrong guess apart from a right one, and guessing went on unbounded.
    const real = (ip: string) =>
      pipeline.handle(call('GET', '/v1/case-list', { authorization: 'Bearer tok-read' }), {
        role: 'web',
        ip,
      });
    expect((await real('203.0.113.9')).status).toBe(429);
    expect((await real('198.51.100.4')).status).toBe(200);
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
