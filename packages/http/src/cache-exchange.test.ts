// A shared cache may hold a response only when the EXCHANGE is one it can replay: a safe method
// and an answer that is not a refusal. The route default keyed off the route and the actor alone,
// so an anonymous `POST /mcp` answered `401` + `WWW-Authenticate` went out as
// `public, max-age=0, s-maxage=60, stale-while-revalidate=600` — a challenge a CDN could hand to the
// next caller, and an OAuth error RFC 6749 §5.1 says must carry `no-store`.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { text } from './response';
import { createRouter, type Route } from './router';

const challenge = (): Response =>
  new Response('{"code":"X_UNAUTHENTICATED"}', {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  });

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/page',
    meta: { name: 'page', auth: 'public' },
    handler: () => text('ok'),
  },
  { method: 'POST', path: '/mcp', meta: { name: 'mcp', auth: 'public' }, handler: challenge },
  { method: 'GET', path: '/gated', meta: { name: 'gated', auth: 'public' }, handler: challenge },
  {
    method: 'POST',
    path: '/token',
    meta: { name: 'token', auth: 'public' },
    handler: () => text('ok'),
  },
  {
    method: 'GET',
    path: '/declared-401',
    meta: { name: 'declared-401', auth: 'public' },
    handler: () => {
      const response = challenge();
      response.headers.set('cache-control', 'public, max-age=0, s-maxage=30');
      return response;
    },
  },
  {
    method: 'POST',
    path: '/hinted',
    meta: { name: 'hinted', auth: 'public', cache: { mode: 'public', sMaxAgeSeconds: 60 } },
    handler: () => text('ok'),
  },
  {
    method: 'GET',
    path: '/private-declared',
    meta: { name: 'private-declared', auth: 'public' },
    handler: () => {
      const response = challenge();
      response.headers.set('cache-control', 'private, max-age=0');
      return response;
    },
  },
];

const pipeline = createPipeline({
  table: createRouter(routes),
  config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
  limiter: createRateLimiter({
    config: {
      enabled: true,
      defaultBucket: 'default',
      tenantBucket: null,
      scope: 'process',
      buckets: { default: { capacity: 100, refillPerSecond: 1 } },
    },
  }),
  hooks: { authenticate: () => null },
});

const call = (method: string, path: string) =>
  pipeline.handle(
    new Request(`http://localhost${path}`, {
      method,
      ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
    }),
    { role: 'web' },
  );

describe('an exchange a shared cache cannot replay is never offered to one', () => {
  test('an anonymous POST answered 401 is no-store, with the HTTP/1.0 echo beside it', async () => {
    const response = await call('POST', '/mcp');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('a GET answered 401 on a public route is no-store too — the refusal is not the page', async () => {
    const response = await call('GET', '/gated');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a successful POST is no-store: an OAuth token response must never be stored', async () => {
    const response = await call('POST', '/token');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  test('a handler that offers a refusal to a CDN is overruled', async () => {
    const response = await call('GET', '/declared-401');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a public hint declared on a POST route is overruled', async () => {
    const response = await call('POST', '/hinted');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a declaration that offers nothing to a shared cache is left as written', async () => {
    const response = await call('GET', '/private-declared');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0');
  });

  test('an anonymous GET answered 200 keeps the shared default — the page is still a page', async () => {
    const response = await call('GET', '/page');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
    expect(response.headers.get('pragma')).toBeNull();
  });
});

// RFC 9111 §3: a shared cache may store a response to a request with no `Authorization` whenever
// it carries explicit freshness — `max-age` alone is enough. `public` and `s-maxage` were the only
// directives read as an offer, so a per-user body under `max-age=3600` went to the CDN as written.
describe('any freshness without private or no-store is an offer to a shared cache', () => {
  const declared = (value: string, actor: 'member' | 'anonymous'): Promise<Response> =>
    createPipeline({
      table: createRouter([
        {
          method: 'GET',
          path: '/me',
          meta: { name: 'me', auth: 'public' },
          handler: () => {
            const response = text('hello, ada');
            response.headers.set('cache-control', value);
            response.headers.set('surrogate-key', 'me');
            return response;
          },
        },
      ]),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
      hooks: { authenticate: () => (actor === 'member' ? ({ id: 'u1' } as never) : null) },
    }).handle(new Request('http://localhost/me', { headers: { cookie: 'session=1' } }), {
      role: 'web',
    });

  for (const value of [
    'max-age=3600',
    'MAX-AGE=3600',
    'max-age=0, must-revalidate',
    'must-revalidate',
    'proxy-revalidate',
    'no-cache, max-age=60',
  ]) {
    test(`a signed-in response declaring "${value}" goes out private`, async () => {
      const response = await declared(value, 'member');
      expect(response.headers.get('cache-control')).toBe('private, max-age=0');
      expect(response.headers.get('surrogate-key')).toBeNull();
    });
  }

  test('what already withholds it, and what is URL-addressed, is left as written', async () => {
    for (const value of [
      'private, max-age=3600',
      'no-store',
      'no-store, max-age=0',
      'public, max-age=31536000, immutable',
    ]) {
      expect((await declared(value, 'member')).headers.get('cache-control')).toBe(value);
    }
  });

  test('the same declaration for an anonymous visitor is kept, keyed on what the body varies by', async () => {
    const response = await declared('max-age=3600', 'anonymous');
    expect(response.headers.get('cache-control')).toBe('max-age=3600');
    expect(response.headers.get('vary')?.split(', ')).toContain('cookie');
  });
});
