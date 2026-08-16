// The two OAuth route descriptors driven as HTTP: a forged state, a declined consent and an
// unknown provider each answer with their own code and status, the body an anonymous caller reads
// carries no developer diagnostics, and the handshake cookie is cleared on every outcome.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import type { OAuthFetch } from './oauth-exchange';
import { oauthCallbackPath, oauthStartPath } from './oauth-paths';
import { registerOAuthProvider } from './oauth-registry';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const SECRET = 'a'.repeat(32);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

let adapter: MemoryAdapter;
let auth: Auth;

beforeEach(() => {
  adapter = new MemoryAdapter();
  auth = defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github', 'google'] });
});

/** The three GitHub calls a client-side login makes, and nothing else. */
const githubFetch = (): OAuthFetch => (input) => {
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

const routes = (): ReturnType<typeof oauthLogin> =>
  oauthLogin(auth, {
    credentials,
    fetch: githubFetch(),
    secret: SECRET,
    baseUrl: 'https://app.test',
  });

/** `name=value` — what a browser sends back, without the attributes it keeps to itself. */
const cookiePair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await response.json();
  // Asserted, never thrown: a bare `Error` has no code and no fix, and this file has no more
  // licence to throw one than the package it drives.
  expect(parsed).toBeObject();
  return parsed as Record<string, unknown>;
};

describe('oauthLogin', () => {
  test('a forged state is refused with the code and the fix that restarts the flow', async () => {
    const login = routes();
    const start = await login.start.handle(new Request('https://app.test/auth/oauth/github'));
    const sealed = cookiePair(start.headers.getSetCookie()[0] ?? '');

    const done = await login.callback.handle(
      new Request('https://app.test/auth/oauth/github/callback?code=the-code&state=forged', {
        headers: { cookie: sealed },
      }),
    );

    expect(done.status).toBe(400);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_STATE_INVALID');
    // Axiom 4: the fix names a route this package actually mounts, not one it wishes existed.
    expect(String(body['fix'])).toContain(`GET ${oauthStartPath('github')}`);
    expect(login.start.path).toBe('/auth/oauth/:provider');
    // A spent handshake must not survive its own failure — the code it authorised is gone.
    expect(done.headers.getSetCookie().some((c) => c.startsWith('__Host-x_oauth_github=;'))).toBe(
      true,
    );
  });

  test('redirect to session: a github login round-trips through the two mounted routes', async () => {
    const login = routes();

    const start = await login.start.handle(new Request('https://app.test/auth/oauth/github'));
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `https://app.test${oauthCallbackPath('github')}`,
    );
    const state = authorize.searchParams.get('state') ?? '';
    expect(state).not.toBe('');

    const setStart = start.headers.getSetCookie();
    expect(setStart).toHaveLength(1);
    expect(setStart[0]).toStartWith('__Host-x_oauth_github=');
    expect(setStart[0]).toContain('HttpOnly');

    const done = await login.callback.handle(
      new Request(`https://app.test/auth/oauth/github/callback?code=the-code&state=${state}`, {
        headers: { cookie: cookiePair(setStart[0] ?? ''), 'user-agent': 'Firefox/1' },
      }),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/');
    const setDone = done.headers.getSetCookie();
    expect(setDone.some((c) => c.startsWith('__Host-x_session='))).toBe(true);
    expect(setDone.some((c) => c.startsWith('__Host-x_oauth_github=;'))).toBe(true);

    const user = await adapter.findUserByEmail('ada@example.com');
    expect(user?.emailVerifiedAt).toEqual(NOW);
    const account = await adapter.findAccount('github', '583231');
    expect(account?.userId).toBe(user?.id ?? '');
    const sessions = await adapter.listSessions(user?.id ?? '');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.userAgent).toBe('Firefox/1');
  });

  test('a provider the app did not enable never reaches the provider', async () => {
    const login = routes();
    const response = await login.start.handle(new Request('https://app.test/auth/oauth/apple'));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
    expect(response.headers.get('location')).toBeNull();
  });

  test('a provider Ultimate has never heard of is the same refusal', async () => {
    const login = routes();
    const response = await login.start.handle(new Request('https://app.test/auth/oauth/facebook'));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
  });

  test('a user pressing Cancel is its own code, never a broken-app one', async () => {
    const login = routes();
    const start = await login.start.handle(new Request('https://app.test/auth/oauth/github'));

    const done = await login.callback.handle(
      new Request('https://app.test/auth/oauth/github/callback?error=access_denied', {
        headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') },
      }),
    );

    // 403, not 502: nothing is misconfigured and no on-call should hear about it.
    expect(done.status).toBe(403);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_DENIED');
    expect(String(body['cause'])).toContain('access_denied');
    expect(String(body['fix'])).toContain(`GET ${oauthStartPath('github')}`);
  });

  test('a callback with no handshake cookie has nothing to check state against', async () => {
    const login = routes();
    const done = await login.callback.handle(
      new Request('https://app.test/auth/oauth/github/callback?code=c&state=s'),
    );

    expect(done.status).toBe(400);
    expect((await bodyOf(done))['code']).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a github handshake may not finish a google callback', async () => {
    const login = routes();
    const start = await login.start.handle(new Request('https://app.test/auth/oauth/github'));
    const sealed = cookiePair(start.headers.getSetCookie()[0] ?? '').replace(
      '__Host-x_oauth_github=',
      '__Host-x_oauth_google=',
    );

    const done = await login.callback.handle(
      new Request('https://app.test/auth/oauth/google/callback?code=c&state=s', {
        headers: { cookie: sealed },
      }),
    );

    expect(done.status).toBe(400);
    expect((await bodyOf(done))['code']).toBe('X_OAUTH_STATE_INVALID');
  });

  test('an unexpected failure is still a coded body, never a stack trace', async () => {
    const login = oauthLogin(auth, {
      credentials,
      secret: SECRET,
      baseUrl: 'https://app.test',
      fetch: () => Promise.reject(new Error('boom')),
    });
    const start = await login.start.handle(new Request('https://app.test/auth/oauth/github'));
    const authorize = new URL(start.headers.get('location') ?? '');

    const done = await login.callback.handle(
      new Request(
        `https://app.test/auth/oauth/github/callback?code=c&state=${authorize.searchParams.get('state')}`,
        { headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') } },
      ),
    );

    expect(done.status).toBe(502);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_EXCHANGE_FAILED');
    // The contract's three fields, and no stack: what makes it debuggable is the fix line, and
    // what makes it publishable is that nothing else rides along.
    expect(body['cause']).toBeString();
    expect(body['fix']).toBeString();
    expect(body).not.toContainKey('stack');
  });

  test('the body an anonymous caller reads carries no meta and no stack', async () => {
    // A provider only this deployment knows about. Registering it here rather than relying on
    // another test file is deliberate: the registry is process-wide, and a test that passes only
    // because a sibling file ran first is a test that cannot fail on its own.
    registerOAuthProvider({
      id: 'acme-internal-sso',
      authorizeUrl: 'https://sso.acme.test/authorize',
      tokenUrl: 'https://sso.acme.test/token',
      userInfoUrl: null,
      userEmailsUrl: null,
      issuers: ['https://sso.acme.test'],
      jwksUri: 'https://sso.acme.test/keys',
      scopes: ['openid', 'email'],
      usesPkce: true,
      usesNonce: true,
      clientIdEnv: 'ACME_INTERNAL_SSO_CLIENT_ID',
      clientSecretEnv: 'ACME_INTERNAL_SSO_CLIENT_SECRET',
    });
    // One provider enabled, so "what this app turned on" and "what ships built in" are two
    // different lists and the refusal can be held to naming the second.
    const login = oauthLogin(
      defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github'] }),
      { credentials, secret: SECRET, baseUrl: 'https://app.test' },
    );

    const body = await bodyOf(
      await login.start.handle(new Request('https://app.test/auth/oauth/apple')),
    );

    // Both legs are public by definition, so `toJSON()` — which carries `meta` and `stack` for a
    // developer — is not what goes on the wire. `meta.enabled` would have published the app's own
    // provider configuration to whoever typed a URL.
    expect(Object.keys(body).sort()).toEqual(['cause', 'code', 'docs', 'fix', 'title']);
    // The three BUILT-INS, which are a framework constant already in the public docs — never the
    // app's `providers` and never the live registry. `google` is built in and NOT enabled here, so
    // a fix that names it is reading the constant rather than this deployment's configuration.
    expect(String(body['fix'])).toContain("'google'");
    // And the other half stays out of it. An app that registered an internal OP has put its own
    // vocabulary into the registry; echoing it back names a system this stranger could not have
    // known exists. The fix is still executable for that branch — it says how to register one.
    expect(String(body['fix'])).not.toContain('acme-internal-sso');
    expect(String(body['fix'])).toContain('registerOAuthProvider');
  });
});
