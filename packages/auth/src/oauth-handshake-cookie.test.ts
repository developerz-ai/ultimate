// The handshake cookie has ONE name and ONE format, shared by `oauthLogin`'s legs and the exported
// `handshakeCookie` family: either leg can be the built-in one and the other hand-built. A 31.1
// adopter mounted `oauthLogin().start` with a custom callback over `readHandshakeCookie` and the
// state was never found — the two wrote `__Host-x_sso_<p>` and read `__Host-x_oauth_<p>`.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { defineAuth } from './auth';
import { memoryAuthAdapter } from './memory-adapter';
import { beginOAuth } from './oauth';
import { sealHandshake } from './oauth-cookie';
import type { OAuthFetch } from './oauth-exchange';
import {
  clearHandshakeCookie,
  handshakeCookie,
  handshakeCookieName,
  readHandshakeCookie,
} from './oauth-handshake-cookie';
import { oauthCallbackPath } from './oauth-paths';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const SECRET = 'a'.repeat(32);
const clock = frozenClock(NOW);
const seal = { secret: SECRET, clock };
const BASE = 'https://app.test';
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

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

const login = () =>
  oauthLogin(defineAuth({ adapter: memoryAuthAdapter(), clock, providers: ['github'] }), {
    credentials,
    fetch: githubFetch,
    secret: SECRET,
    baseUrl: BASE,
  });

const pair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));
const nameOf = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf('='));
const withCookie = (cookie: string, query = ''): Request =>
  new Request(`${BASE}${oauthCallbackPath('github')}${query}`, { headers: { cookie } });

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-UltimateError';
  }
  return 'did-not-throw';
};

/** A handshake bound to the built-in callback URL, as a hand-built start leg would begin it. */
const handBuilt = () =>
  beginOAuth({
    provider: 'github',
    clientId: credentials.clientId,
    redirectUri: `${BASE}${oauthCallbackPath('github')}`,
  });

describe('one handshake cookie for every reader and writer', () => {
  test("the start leg's cookie is the name handshakeCookieName answers", async () => {
    const start = await login().start.handle(new Request(`${BASE}/auth/sso/github`));
    const set = start.headers.getSetCookie()[0] ?? '';
    expect(nameOf(set)).toBe(handshakeCookieName('github'));
    expect(nameOf(handshakeCookie(handBuilt(), seal))).toBe(handshakeCookieName('github'));
    expect(nameOf(clearHandshakeCookie('github'))).toBe(nameOf(set));
  });

  test("readHandshakeCookie opens the built-in start leg's handshake", async () => {
    const start = await login().start.handle(new Request(`${BASE}/auth/sso/github`));
    const authorize = new URL(start.headers.get('location') ?? '');
    const request = withCookie(pair(start.headers.getSetCookie()[0] ?? ''));
    const handshake = readHandshakeCookie(request, 'github', seal);
    expect(handshake.provider).toBe('github');
    expect(handshake.state).toBe(authorize.searchParams.get('state') ?? 'missing');
    expect(handshake.redirectUri).toBe(`${BASE}${oauthCallbackPath('github')}`);
    expect(handshake.verifier.length).toBeGreaterThanOrEqual(43);
  });

  test('the built-in callback finishes a handshakeCookie start leg', async () => {
    const handshake = handBuilt();
    const done = await login().callback.handle(
      withCookie(pair(handshakeCookie(handshake, seal)), `?code=c&state=${handshake.state}`),
    );
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((c) => c.startsWith('__Host-x_session='))).toBe(true);
  });

  test('a handshake written for one provider is not opened for another', () => {
    const request = withCookie(
      pair(handshakeCookie(handBuilt(), seal)).replace('_github=', '_google='),
    );
    expect(codeOf(() => readHandshakeCookie(request, 'google', seal))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });
});

describe('the __Host-x_oauth_<p> cookie (31.1 and before), for one release', () => {
  const LEGACY = '__Host-x_oauth_github';

  test('a handshake an old pod sealed under __Host-x_oauth_<p> still opens', () => {
    const handshake = handBuilt();
    const request = withCookie(`${LEGACY}=${sealHandshake(handshake, seal)}`);
    expect(readHandshakeCookie(request, 'github', seal)).toEqual(handshake);
  });

  test('the current cookie wins when a browser carries both', () => {
    const old = handBuilt();
    const fresh = handBuilt();
    const request = withCookie(
      `${LEGACY}=${sealHandshake(old, seal)}; ${pair(handshakeCookie(fresh, seal))}`,
    );
    expect(readHandshakeCookie(request, 'github', seal).state).toBe(fresh.state);
  });

  test('a custom name still opens the old format written under it', () => {
    const handshake = handBuilt();
    const request = withCookie(`mine=${sealHandshake(handshake, seal)}`);
    expect(readHandshakeCookie(request, 'github', { ...seal, name: 'mine' })).toEqual(handshake);
  });

  test('the legacy cookie is still signed: a forged one is refused', () => {
    const request = withCookie(
      `${LEGACY}=${sealHandshake(handBuilt(), { ...seal, secret: 'b'.repeat(32) })}`,
    );
    expect(codeOf(() => readHandshakeCookie(request, 'github', seal))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });
});
