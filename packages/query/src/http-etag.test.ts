// A declared read's validator, over the real pipeline: 200 with an ETag, then a bodiless 304 for
// the same caller; another actor's validator never matches; a denied caller is 403, never 304; and
// a 304 still spends the read's rate limit, because it is still a read of that person's rows.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { resetRateLimitStore } from '@ultimat3/http/adapter';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { type AnyQuery, query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly rank: number;
}

const posts: readonly Post[] = [
  { id: 'a', rank: 1 },
  { id: 'b', rank: 2 },
];

const reader = (id: string): Actor => ({ ...userActor({ id }), permissions: ['feed:read'] });
const stranger = (id: string): Actor => ({ ...userActor({ id }), permissions: [] });

function feed(options: { etag?: true; limit?: number } = { etag: true }): AnyQuery {
  return query({
    input: t.object({}),
    policy: can('feed:read'),
    ...(options.etag === undefined ? {} : { etag: options.etag }),
    ...(options.limit === undefined
      ? {}
      : { rateLimit: { limit: options.limit, windowMs: 60_000 } }),
    sql: () => from<Post>('posts', posts).orderBy('rank'),
  }).named('feed');
}

function serve(target: AnyQuery, actor: Actor) {
  return httpServer({
    routes: [toQueryRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });
}

const get = (server: ReturnType<typeof serve>, etag?: string): Promise<Response> =>
  server.fetch(
    new Request('http://dev.test/_x/query/feed', {
      headers: etag === undefined ? {} : { 'if-none-match': etag },
    }),
  );

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

describe('query({ etag: true }) over HTTP', () => {
  test('200 with a validator and private, no-cache; then 304 with no body', async () => {
    const server = serve(feed(), reader('u1'));
    const first = await get(server);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(await first.json()).toEqual(posts);

    const again = await get(server, etag ?? '');
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe('private, no-cache');
  });

  test('another actor`s validator does not match, even over the same rows', async () => {
    const mine = (await get(serve(feed(), reader('u1')))).headers.get('etag') ?? '';
    const theirs = await get(serve(feed(), reader('u2')), mine);
    expect(theirs.status).toBe(200);
    expect(theirs.headers.get('etag')).not.toBe(mine);
  });

  test('a denied caller holding a valid validator gets 403, never 304', async () => {
    const etag = (await get(serve(feed(), reader('u1')))).headers.get('etag') ?? '';
    const denied = await get(serve(feed(), stranger('u1')), etag);
    expect(denied.status).toBe(403);
  });

  test('the rate limit spends on a 304', async () => {
    const server = serve(feed({ etag: true, limit: 2 }), reader('u1'));
    const etag = (await get(server)).headers.get('etag') ?? '';
    expect((await get(server, etag)).status).toBe(304);
    expect((await get(server, etag)).status).toBe(429);
  });

  test('undeclared, a read stays no-store with no validator', async () => {
    const response = await get(serve(feed({}), reader('u1')));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
  });
});

describe('where etag is refused', () => {
  test('a live read: X_QUERY_ETAG_INVALID at declaration', () => {
    expect(() =>
      query({
        input: t.object({}),
        policy: can('feed:read'),
        live: true,
        etag: true,
        sql: () => from<Post>('posts', posts).orderBy('rank'),
      }),
    ).toThrow('X_QUERY_ETAG_INVALID');
  });
});

describe('the OpenAPI operation of a declaring read', () => {
  test('documents If-None-Match, the ETag header and the 304; an undeclared read none of them', async () => {
    const { toQueryOpenApiOperation } = await import('./openapi');
    const declared = JSON.stringify(toQueryOpenApiOperation(feed()));
    expect(declared).toContain('"If-None-Match"');
    expect(declared).toContain('"304"');
    expect(declared).toContain('"ETag"');
    const plain = JSON.stringify(toQueryOpenApiOperation(feed({})));
    expect(plain).not.toContain('If-None-Match');
    expect(plain).not.toContain('"304"');
  });
});
