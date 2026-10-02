// `authRequest`: the two arguments an app's authenticator is handed, built for real. The test of
// an authenticator used to fabricate both behind `as unknown as Parameters<typeof authenticate>[0]`
// — a cast that keeps compiling when the authenticator starts reading something the fake lacks.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import type { Authenticator } from '@ultimat3/http';
import { authRequest } from './auth-request';
import { testName } from './test-types';

const ada = userActor({ id: 'ada', orgId: 'org-1' });

/** An authenticator as an app writes one: typed by the hook, reading the request's own methods. */
const authenticate: Authenticator = (request, ctx): Actor | null => {
  if (request.cookie('session') === 'ada token') return ada;
  if (request.header('authorization') === 'Bearer k-1') return ada;
  if (ctx.requestHeaders.get('x-api-key') === 'k-2' && request.pathname === '/v1/posts') return ada;
  return null;
};

describe(testName('unit', 'authRequest'), () => {
  test('with nothing named, the request is anonymous: no cookie, no credential', async () => {
    const [request, ctx] = await authRequest();
    expect(request.header('cookie')).toBeNull();
    expect(request.header('authorization')).toBeNull();
    expect(request.method).toBe('GET');
    expect(ctx.actor.kind).toBe('anonymous');
    expect(await authenticate(request, ctx)).toBeNull();
  });

  test('cookies arrive as the one header a browser sends, values encoded', async () => {
    const args = await authRequest({ cookies: { theme: 'dark', session: 'ada token' } });
    expect(args[0].header('cookie')).toBe('theme=dark; session=ada%20token');
    expect(args[0].cookie('session')).toBe('ada token');
    // Spread straight into the authenticator: the tuple is its parameter list.
    expect(await authenticate(...args)).toBe(ada);
  });

  test('bearer is the Authorization header', async () => {
    expect(await authenticate(...(await authRequest({ bearer: 'k-1' })))).toBe(ada);
    expect(await authenticate(...(await authRequest({ bearer: 'k-9' })))).toBeNull();
  });

  test('headers, url and method reach the request AND the context it carries', async () => {
    const [request, ctx] = await authRequest({
      url: 'https://example.test/v1/posts?page=2',
      method: 'post',
      headers: { 'x-api-key': 'k-2' },
    });
    expect(request.method).toBe('POST');
    expect(request.pathname).toBe('/v1/posts');
    expect(ctx.url.searchParams.get('page')).toBe('2');
    expect(request.ctx).toBe(ctx);
    expect(await authenticate(request, ctx)).toBe(ada);
  });

  test('cookies and bearer win over the same header spelled in `headers`', async () => {
    const [request] = await authRequest({
      headers: { cookie: 'session=stale', authorization: 'Basic x' },
      cookies: { session: 'fresh' },
      bearer: 'k-1',
    });
    expect(request.cookie('session')).toBe('fresh');
    expect(request.header('authorization')).toBe('Bearer k-1');
  });
});
