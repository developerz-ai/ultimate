// `oauthLogin({ callbackPath })`: the one place an app keeps the `redirect_uri` its IdP already has
// registered (a v30 `/auth/oauth/:provider/callback`, a Google console nobody can edit). One
// pattern moves the mount, the `redirect_uri` sent and the URL the callback checks it against.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { defineAuth } from './auth';
import { memoryAuthAdapter } from './memory-adapter';
import type { OAuthFetch } from './oauth-exchange';
import { OAUTH_CALLBACK_ROUTE_PATH } from './oauth-paths';
import { type OAuthLoginOptions, oauthLogin } from './oauth-route';

const BASE = 'https://app.test';
const LEGACY = '/auth/oauth/:provider/callback';

const githubFetch: OAuthFetch = (input) => {
  if (input === 'https://github.com/login/oauth/access_token') {
    return Promise.resolve(Response.json({ access_token: 'gho_first', token_type: 'bearer' }));
  }
  if (input === 'https://api.github.com/user') {
    return Promise.resolve(Response.json({ id: 583231, login: 'ada', name: 'Ada Lovelace' }));
  }
  if (input === 'https://api.github.com/user/emails') {
    return Promise.resolve(
      Response.json([{ email: 'ada@example.com', primary: true, verified: true }]),
    );
  }
  return Promise.resolve(new Response('unexpected', { status: 500 }));
};

const login = (options: OAuthLoginOptions = {}) =>
  oauthLogin(
    defineAuth({
      adapter: memoryAuthAdapter(),
      clock: frozenClock(new Date('2026-11-10T12:00:00.000Z')),
      providers: ['github'],
    }),
    {
      credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
      fetch: githubFetch,
      secret: 'a'.repeat(32),
      baseUrl: BASE,
      ...options,
    },
  );

const pair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-UltimateError';
  }
  return 'did-not-throw';
};

/** Start, then answer the callback at `callbackUrl` as the IdP would. */
async function roundTrip(routes: ReturnType<typeof login>, callbackUrl: string) {
  const start = await routes.start.handle(new Request(`${BASE}/auth/sso/github`));
  const authorize = new URL(start.headers.get('location') ?? '');
  const state = authorize.searchParams.get('state') ?? '';
  const done = await routes.callback.handle(
    new Request(`${callbackUrl}?code=c&state=${state}`, {
      headers: { cookie: pair(start.headers.getSetCookie()[0] ?? '') },
    }),
  );
  return { redirectUri: authorize.searchParams.get('redirect_uri'), done };
}

describe('oauthLogin callbackPath', () => {
  test('omitted, the callback is the framework path', () => {
    expect(login().callback.path).toBe(OAUTH_CALLBACK_ROUTE_PATH);
  });

  test('set, it is the mount, the redirect_uri and the URL the callback checks', async () => {
    const routes = login({ callbackPath: LEGACY });
    expect(routes.callback.path).toBe(LEGACY);
    const { redirectUri, done } = await roundTrip(routes, `${BASE}/auth/oauth/github/callback`);
    expect(redirectUri).toBe(`${BASE}/auth/oauth/github/callback`);
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((c) => c.startsWith('__Host-x_session='))).toBe(true);
  });

  test('the provider segment is read where the pattern puts it, not at a fixed offset', async () => {
    const routes = login({ callbackPath: '/oauth2/:provider/return/here' });
    const { redirectUri, done } = await roundTrip(routes, `${BASE}/oauth2/github/return/here`);
    expect(redirectUri).toBe(`${BASE}/oauth2/github/return/here`);
    expect(done.status).toBe(303);
  });

  test('a pattern a router cannot mount or the provider cannot be read from is refused', () => {
    for (const callbackPath of [
      'auth/oauth/:provider/callback',
      '/auth/oauth/callback',
      '/auth/:provider/:provider',
      '/auth/:provider/:other',
      '/auth/:provider/callback?x=1',
      '/auth/:provider/cb#frag',
      '/auth/sso/:provider',
      '/auth/:provider-x/callback',
      // Each of these normalises to another path, so the provider segment is lost or moved.
      '/auth/:provider/../callback',
      '/auth/:provider/./callback',
      '/auth//:provider/callback',
      '/auth/:provider/callback/',
      '/auth/%2e%2e/:provider/callback',
      '/auth/:provider/%2Fcallback',
      '/auth\\:provider/callback',
      '/auth/:provider/cb x',
    ]) {
      expect([callbackPath, codeOf(() => login({ callbackPath }))]).toEqual([
        callbackPath,
        'X_CONFIG_INVALID',
      ]);
    }
  });
});
