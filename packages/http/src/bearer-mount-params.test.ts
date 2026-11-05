// A `:param` route under a bearer mount: a pinned action at `/orders/:id/refund` is served at
// `/v1/orders/:id/refund` with its param decoded, the scope cut still answers 404 and the
// catch-all still 401 — with no change to `bearer-mount.ts` beyond its header comment.

import { describe, expect, test } from 'bun:test';
import { type Actor, agentActor, frozenClock } from '@ultimat3/core';
import { bearerMount, mountedPath } from './bearer-mount';
import { defineHttpConfig } from './config';
import { useRequestContext } from './context';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore } from './rate-limit';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const agent: Actor = agentActor({ id: 'user_1', orgId: 'org_1' });

const echo = (): Response => jsonResponse({ params: useRequestContext()?.params ?? null });

const api: readonly Route[] = [
  {
    method: 'POST',
    path: '/orders/:id/refund',
    meta: { name: 'refundOrder', auth: 'required', enforcedBy: 'handler' },
    handler: echo,
  },
  {
    method: 'GET',
    path: '/orders/:id',
    meta: { name: 'orderById', auth: 'required', enforcedBy: 'handler' },
    handler: echo,
  },
];

const pipeline = () => {
  const mounted = bearerMount({
    prefix: '/v1',
    routes: api,
    scopes: { 'orders:write': ['refundOrder'], 'orders:read': ['orderById'] },
    resolveToken: (token) =>
      token === 'tok-write' ? { actor: agent, scopes: new Set(['orders:write']) } : null,
    rateLimitStore: memoryRateLimitStore(),
    clock: frozenClock(0),
  });
  return httpPipeline({
    table: httpRouter([...api, ...mounted]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  });
};

const call = (method: string, path: string, token?: string): Request =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

describe('a parameterised route under a bearer mount', () => {
  test('the mounted path keeps the template', () => {
    expect(mountedPath('/v1', '/orders/:id/refund')).toBe('/v1/orders/:id/refund');
  });

  test('served at /v1/orders/:id/refund, the param decoded as one value', async () => {
    const response = await pipeline().handle(call('POST', '/v1/orders/a%2Fb/refund', 'tok-write'), {
      role: 'web',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ params: { id: 'a/b' } });
  });

  test('a token without the scope is 404, no token is the catch-all 401', async () => {
    expect(
      (await pipeline().handle(call('GET', '/v1/orders/o-1', 'tok-write'), { role: 'web' })).status,
    ).toBe(404);
    const anonymous = await pipeline().handle(call('POST', '/v1/orders/o-1/refund'), {
      role: 'web',
    });
    expect(anonymous.status).toBe(401);
    expect((await pipeline().handle(call('GET', '/v1/nothing/here'), { role: 'web' })).status).toBe(
      401,
    );
  });
});
