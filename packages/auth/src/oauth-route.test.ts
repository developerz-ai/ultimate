// The two OAuth route descriptors driven as HTTP: a forged state, a declined consent and an
// unknown provider each answer with their own code and status, the developer's cause and fix go
// to the `auth.oauth.refused` log line, and the handshake cookie is cleared on every outcome.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, setLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { oauthRouteStatus } from './identity-provider-status';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import type { OAuthFetch } from './oauth-exchange';
import { oauthCallbackPath, oauthStartPath } from './oauth-paths';
import { registerOAuthProvider } from './oauth-registry';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-08-15T12:00:00.000Z');

const SECRET = 'a'.repeat(32);

const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

let adapter: MemoryAuthAdapter;

let auth: Auth;

let logged: string[];

let previousSink: ReturnType<typeof setLogSink>;

beforeEach(() => {
  adapter = memoryAuthAdapter();
  auth = defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github', 'google'] });
  logged = [];
  previousSink = setLogSink((line) => {
    logged.push(line);
  });
});

afterEach(() => {
  setLogSink(previousSink);
});

/** The developer's half of the last refusal: its cause and fix, where only an operator reads. */
const refused = (): string => logged.findLast((line) => line.includes('auth.oauth.refused')) ?? '';

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
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
    const sealed = cookiePair(start.headers.getSetCookie()[0] ?? '');

    const done = await login.callback.handle(
      new Request('https://app.test/auth/sso/github/callback?code=the-code&state=forged', {
        headers: { cookie: sealed },
      }),
    );

    expect(done.status).toBe(400);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_STATE_INVALID');
    // Axiom 4: the fix names a route this package actually mounts, not one it wishes existed.
    expect(refused()).toContain(`GET ${oauthStartPath('github')}`);
    expect(login.start.path).toBe('/auth/sso/:provider');
    // A forged state is not this browser's answer: the cookie survives, so a cross-site request
    // carrying it cannot end the real sign-in in flight. A bound answer clears it on any outcome.
    expect(done.headers.getSetCookie().some((c) => c.startsWith('__Host-x_sso_github=;'))).toBe(
      false,
    );
  });

  test('redirect to session: a github login round-trips through the two mounted routes', async () => {
    const login = routes();

    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
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
    expect(setStart[0]).toStartWith('__Host-x_sso_github=');
    expect(setStart[0]).toContain('HttpOnly');

    const done = await login.callback.handle(
      new Request(`https://app.test/auth/sso/github/callback?code=the-code&state=${state}`, {
        headers: { cookie: cookiePair(setStart[0] ?? ''), 'user-agent': 'Firefox/1' },
      }),
    );

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/');
    const setDone = done.headers.getSetCookie();
    expect(setDone.some((c) => c.startsWith('__Host-x_session='))).toBe(true);
    expect(setDone.some((c) => c.startsWith('__Host-x_sso_github=;'))).toBe(true);

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
    const response = await login.start.handle(new Request('https://app.test/auth/sso/apple'));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
    expect(response.headers.get('location')).toBeNull();
  });

  test('a provider Ultimate has never heard of is the same refusal', async () => {
    const login = routes();
    const response = await login.start.handle(new Request('https://app.test/auth/sso/facebook'));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
  });

  test('a user pressing Cancel is its own code, never a broken-app one', async () => {
    const login = routes();
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));

    // RFC 6749 4.1.2.1: the error redirect echoes `state`, which binds it to this browser.
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const done = await login.callback.handle(
      new Request(`https://app.test/auth/sso/github/callback?error=access_denied&state=${state}`, {
        headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') },
      }),
    );

    // 403, not 502: nothing is misconfigured and no on-call should hear about it.
    expect(done.status).toBe(403);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_DENIED');
    expect(refused()).toContain('access_denied');
    expect(refused()).toContain(`GET ${oauthStartPath('github')}`);
  });

  test('a callback with no handshake cookie has nothing to check state against', async () => {
    const login = routes();
    const done = await login.callback.handle(
      new Request('https://app.test/auth/sso/github/callback?code=c&state=s'),
    );

    expect(done.status).toBe(400);
    expect((await bodyOf(done))['code']).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a github handshake may not finish a google callback', async () => {
    const login = routes();
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
    const sealed = cookiePair(start.headers.getSetCookie()[0] ?? '').replace(
      '__Host-x_sso_github=',
      '__Host-x_sso_google=',
    );

    const done = await login.callback.handle(
      new Request('https://app.test/auth/sso/google/callback?code=c&state=s', {
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
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
    const authorize = new URL(start.headers.get('location') ?? '');

    const done = await login.callback.handle(
      new Request(
        `https://app.test/auth/sso/github/callback?code=c&state=${authorize.searchParams.get('state')}`,
        { headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') } },
      ),
    );

    expect(done.status).toBe(502);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(body['cause']).toBeString();
    expect(body['fix']).toBe('x errors explain X_OAUTH_EXCHANGE_FAILED --json');
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
      await login.start.handle(new Request('https://app.test/auth/sso/apple')),
    );

    // Both legs are public by definition, so `toJSON()` — which carries `meta` and `stack` for a
    // developer — is not what goes on the wire. `meta.enabled` would have published the app's own
    // provider configuration to whoever typed a URL.
    expect(Object.keys(body).sort()).toEqual(['cause', 'code', 'docs', 'fix', 'title']);
    // The body names no provider at all, enabled, built in or registered.
    expect(JSON.stringify(body)).not.toContain('google');
    expect(JSON.stringify(body)).not.toContain('acme-internal-sso');
    // The refusal itself still lists the three BUILT-INS and never the live registry: `google` is
    // built in and NOT enabled here, so the line is reading the constant, not this deployment.
    expect(refused()).toContain("'google'");
    expect(refused()).not.toContain('acme-internal-sso');
    expect(refused()).toContain('registerOAuthProvider');
  });
});

/**
 * The uniform-404 control, made real.
 *
 * `defineAuth` defaulted `providers` to `config.providers ?? oauthProviderIds()` — the LIVE
 * REGISTRY — so nothing was ever "left out" and `assertEnabled`'s second branch could not fire.
 * Past it, `oauthCredentials` threw `X_ENV_MISSING` and `problem()` published its `cause` and
 * `fix` with a 500. So `500 = registered, 404 = not`, which is the enumeration oracle the two
 * branches were collapsed into one answer to prevent — and the 500's cause names the app's own
 * environment variables to whoever typed the URL.
 */
/**
 * `options.env` answered the start leg and not the callback: the check asked it, dropped the
 * answer, and the exchange re-read `Bun.env`. A host handing `serveApp({ env })` got a redirect out
 * and a 500 back.
 */
describe('credentials read from options.env', () => {
  test('reach the token exchange on the callback, with Bun.env empty of them', async () => {
    expect(Bun.env['GITHUB_CLIENT_ID']).toBeUndefined();
    const sent: string[] = [];
    const answer = githubFetch();
    const route = oauthLogin(
      defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github'] }),
      {
        secret: SECRET,
        baseUrl: 'https://app.test',
        env: { GITHUB_CLIENT_ID: 'from-options-env', GITHUB_CLIENT_SECRET: 'env-secret' },
        fetch: (input, init) => {
          if (typeof init?.body === 'string') sent.push(init.body);
          else if (init?.body instanceof URLSearchParams) sent.push(init.body.toString());
          return answer(input, init);
        },
      },
    );

    const started = await route.start.handle(new Request('https://app.test/auth/sso/github'));
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get('location') ?? '');
    expect(location.searchParams.get('client_id')).toBe('from-options-env');
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const state = location.searchParams.get('state') ?? '';

    const back = await route.callback.handle(
      new Request(`https://app.test/auth/sso/github/callback?code=abc&state=${state}`, {
        headers: { cookie },
      }),
    );
    expect(back.status).toBe(303);
    expect(sent.join('&')).toContain('from-options-env');
  });
});

describe('a provider with no credentials is 404, not a 500 naming its env vars', () => {
  const noCredentials = (): ReturnType<typeof oauthLogin> =>
    oauthLogin(defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github'] }), {
      secret: SECRET,
      baseUrl: 'https://app.test',
      // No `credentials`, and an env with nothing in it: `oauthCredentials` is the thing that runs.
      env: {},
    });

  test('the start leg answers the same 404 an unknown provider gets', async () => {
    const response = await noCredentials().start.handle(
      new Request('https://app.test/auth/sso/github'),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(404);
    expect(body['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
    // The env var names are the app's configuration and never reach an anonymous caller.
    expect(JSON.stringify(body)).not.toContain('GITHUB_CLIENT_ID');
    expect(JSON.stringify(body)).not.toContain('GITHUB_CLIENT_SECRET');
  });

  test('the callback leg answers it too — one oracle closed on both halves', async () => {
    const response = await noCredentials().callback.handle(
      new Request('https://app.test/auth/sso/github/callback?code=x&state=y'),
    );
    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
  });

  test('an app that names no providers enables none — the default is [], not the registry', () => {
    // BREAKING: `providers` defaulted to every registered provider, so an app that declared
    // nothing had them all on. A capability is declared, never inherited from a global registry
    // some dependency wrote into.
    expect(defineAuth({ adapter, clock: frozenClock(NOW) }).providers).toEqual([]);
  });
});

/**
 * `OAUTH_ROUTE_STATUS[coded.code] ?? 502` is an index read on a plain object, so `Object.prototype`
 * answers for four names nobody declared. A code of `toString` yielded a FUNCTION, handed straight
 * to `ResponseInit.status`.
 */
describe('a status is looked up as an OWN key of the table', () => {
  test('a code that collides with Object.prototype falls back to 502', () => {
    for (const code of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(oauthRouteStatus(code)).toBe(502);
    }
  });

  test('a declared code still answers its own status', () => {
    expect(oauthRouteStatus('X_OAUTH_PROVIDER_UNKNOWN')).toBe(404);
    expect(oauthRouteStatus('X_ACCOUNT_LOCKED')).toBe(429);
    expect(oauthRouteStatus('X_NEVER_DECLARED')).toBe(502);
  });
});
