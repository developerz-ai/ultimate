/**
 * unit — "log in with GitHub" as `runtime.ts` SERVES it: both legs through a real `httpServer`, the
 * provider a stub answering in process (no client id exists in CI), and the session the callback
 * mints read back by Postly's own authenticator as the member who signed in. `login.test.ts` holds
 * the declaration's refusals; this holds that the declaration is mounted at all.
 */

import { db, driver } from '@postly/db';
import { defineAuth, memoryAuthAdapter, type OAuthFetch, oauthLogin } from '@ultimat3/auth';
import { actorFact, ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { afterEach, describe, expect, fakeSamlIdentityProvider, test } from '@ultimat3/testing';
import { sessionAuthenticator } from './authenticator';
import { postlyAuth } from './login';
import { AFTER_SIGN_IN } from './sign-in-paths';
import {
  OAUTH_CALLBACK_META,
  SIGN_IN_CALLBACK_PATH,
  SIGN_IN_START_PATH,
  signInRoutes,
} from './sign-in-routes';
import { spEntityId } from './sso';

const NOW = new Date('2026-11-13T09:00:00.000Z');
const ORIGIN = 'https://postly.test';
const ORG = '00000000-0000-4000-8000-00000000d0a1';
const MEMBER = '00000000-0000-4000-8000-00000000d0b1';
const EMAIL = 'ines@acme.example';

afterEach(() => {
  driver.reset?.();
});

/** The three calls a GitHub login makes, answered in process — the provider is the one stub. */
const githubFetch: OAuthFetch = (input) => {
  if (input === 'https://github.com/login/oauth/access_token') {
    return Promise.resolve(Response.json({ access_token: 'gho_postly', token_type: 'bearer' }));
  }
  if (input === 'https://api.github.com/user') {
    return Promise.resolve(Response.json({ id: 9001, login: 'ines', name: 'Inés Duarte' }));
  }
  if (input === 'https://api.github.com/user/emails') {
    return Promise.resolve(Response.json([{ email: EMAIL, primary: true, verified: true }]));
  }
  return Promise.resolve(new Response('a call this login does not make', { status: 500 }));
};

const LOGIN = {
  credentials: { clientId: 'postly-client-id', clientSecret: 'postly-client-secret' },
  fetch: githubFetch,
  secret: 'postly-test-handshake-secret-000',
  baseUrl: ORIGIN,
} as const;

const serve = (
  env: Readonly<Record<string, string>>,
  auth = postlyAuth({ adapter: memoryAuthAdapter(), clock: frozenClock(NOW) }),
) => ({
  auth,
  server: httpServer({
    routes: [...signInRoutes(env, { auth: () => Promise.resolve(auth), login: LOGIN })],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  }),
});

const cookiePair = (line: string): string => line.slice(0, line.indexOf(';'));

/** A member of a stored org whose `x_users` row proved the address GitHub is about to vouch for. */
async function seatMember(auth: ReturnType<typeof postlyAuth>): Promise<void> {
  await db.orgs.insert({ id: ORG, slug: 'acme-login', name: 'Acme', planCode: 'team' });
  await db.members.insert({
    id: MEMBER,
    orgId: ORG,
    userId: MEMBER,
    email: EMAIL,
    name: 'Inés Duarte',
  });
  await auth.adapter.createUser({
    id: MEMBER,
    email: EMAIL,
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: NOW,
  });
  await auth.adapter.updateUser(MEMBER, { emailVerifiedAt: NOW });
}

describe('the mounted GitHub login', () => {
  test('mounts at the paths oauthLogin serves, with the callback meta it builds', () => {
    const built = oauthLogin(defineAuth({ adapter: memoryAuthAdapter() }), LOGIN);
    expect(SIGN_IN_START_PATH).toBe(built.start.path);
    expect(SIGN_IN_CALLBACK_PATH).toBe(built.callback.path);
    expect(built.callback.meta).toEqual(OAUTH_CALLBACK_META);
    expect(signInRoutes({}).map((route) => [route.method, route.path])).toEqual([
      ['GET', SIGN_IN_START_PATH],
      ['GET', SIGN_IN_CALLBACK_PATH],
    ]);
  });

  test('a round trip signs the member in: start, the provider, the callback, a session Postly resolves', async () => {
    const { auth, server } = serve({});
    await seatMember(auth);

    const started = await server.fetch(new Request(`${ORIGIN}/auth/sso/github`));
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get('location') ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/sso/github/callback`);

    // The provider sends the browser back with a code and the state it was handed.
    const state = authorize.searchParams.get('state') ?? '';
    const done = await server.fetch(
      new Request(`${ORIGIN}/auth/sso/github/callback?code=the-code&state=${state}`, {
        headers: { cookie: started.headers.getSetCookie().map(cookiePair).join('; ') },
      }),
    );
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(AFTER_SIGN_IN);

    // The cookie the browser now holds, through the authenticator every request runs.
    const cookies = new Map(
      done.headers.getSetCookie().map((line) => cookiePair(line).split('=', 2) as [string, string]),
    );
    const authenticate = sessionAuthenticator({ auth: () => auth, development: false });
    const actor = await runWithContext(ctxOf({}), () =>
      authenticate({ cookie: (name) => cookies.get(name) ?? null, header: () => null }),
    );
    expect(actor?.id).toBe(MEMBER);
    expect(actorFact(actor ?? undefined, 'org')?.id).toBe(ORG);
  });

  test('a provider Postly never enabled is a 404 by code from the mount', async () => {
    const { server } = serve({});
    const response = await server.fetch(new Request(`${ORIGIN}/auth/sso/google`));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code?: unknown }).code).toBe('X_OAUTH_PROVIDER_UNKNOWN');
  });
});

describe('beside a SAML directory', () => {
  test('the one start mount sends `corp` to the IdP and `github` to GitHub', async () => {
    const clock = frozenClock(NOW);
    const idp = await fakeSamlIdentityProvider({
      audience: spEntityId(ORIGIN),
      clock,
      users: [{ nameId: 'u-ines', email: EMAIL }],
    });
    const env = {
      POSTLY_SSO_IDP_METADATA: idp.metadataXml,
      POSTLY_SSO_EMAIL_DOMAINS: 'acme.example',
      APP_URL: ORIGIN,
      SESSION_SECRET: LOGIN.secret,
    };
    const { server } = serve(env);
    expect(signInRoutes(env).map((route) => route.method)).toEqual(['GET', 'GET', 'POST']);

    const saml = await server.fetch(new Request(`${ORIGIN}/auth/sso/corp`));
    const github = await server.fetch(new Request(`${ORIGIN}/auth/sso/github`));

    expect(new URL(github.headers.get('location') ?? '').host).toBe('github.com');
    expect(saml.headers.get('location') ?? '').not.toContain('github.com');
    // The SAML leg answered — a redirect to the IdP, or its own refusal when this process names no
    // `APP_URL` — and never the OAuth start's 404 for a provider it does not know.
    expect(saml.status).not.toBe(404);
    expect(await saml.text()).not.toContain('X_OAUTH_PROVIDER_UNKNOWN');
  });
});
