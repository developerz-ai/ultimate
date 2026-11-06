// A route declaring `csrf: 'cookieless'` — an RFC 6749 token endpoint, client-authenticated and
// PKCE-bound — is reached by a cross-origin browser POST, because no cookie can make that request
// anyone's. Every other route keeps the origin proof, and the flag cannot be declared on a route
// the app's cookie authenticator would still run on.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';

const member = { id: 'u1' } as unknown as Actor;

const routes: readonly Route[] = [
  {
    method: 'POST',
    path: '/oauth/token',
    meta: { name: 'oauth:token', auth: 'public', csrf: 'cookieless', authenticate: () => null },
    handler: () => textResponse('token'),
  },
  {
    method: 'POST',
    path: '/orders/refund',
    meta: { name: 'refund', auth: 'public' },
    handler: () => textResponse('refunded'),
  },
];

const pipeline = httpPipeline({
  table: httpRouter(routes),
  config: defineHttpConfig({ dev: false, buildId: null, rateLimit: { scope: 'process' } }),
  // The app's session authenticator: a cookie makes the caller a member.
  hooks: { authenticate: (request) => (request.cookie('sid') === 'u1' ? member : null) },
});

const crossSite = (path: string, cookie?: string) =>
  pipeline.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: 'grant_type=client_credentials',
    }),
    { role: 'web', ip: '203.0.113.9' },
  );

describe("csrf: 'cookieless'", () => {
  test('a cross-origin browser POST with no cookie reaches the token endpoint', async () => {
    const response = await crossSite('/oauth/token');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('token');
  });

  // The route's own authenticator answers null, so a session cookie authenticates nothing there.
  test('a cookie a cross-site page attached makes nobody the caller there', async () => {
    expect((await crossSite('/oauth/token', 'sid=u1')).status).toBe(200);
  });

  test('a cookie-bearing cross-site POST to a normal route is still refused', async () => {
    const response = await crossSite('/orders/refund', 'sid=u1');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'X_CSRF_BLOCKED' });
  });

  test('an anonymous cross-site POST to a normal route is still refused (login CSRF)', async () => {
    expect((await crossSite('/orders/refund')).status).toBe(403);
  });

  // Without its own authenticator the route runs the app's, which reads the session cookie — so
  // "cookieless" would be a claim the route does not keep.
  test('declared without meta.authenticate, the router refuses it', () => {
    expect(() =>
      httpRouter([
        {
          method: 'POST',
          path: '/oauth/token',
          meta: { name: 'oauth:token', auth: 'public', csrf: 'cookieless' },
          handler: () => textResponse('token'),
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'X_CONFIG_INVALID' }));
  });
});
