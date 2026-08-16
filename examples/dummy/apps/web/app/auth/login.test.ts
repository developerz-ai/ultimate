/**
 * The round trip "log in with GitHub" is, driven through Postly's OWN declaration: its providers,
 * its link policy, its landing path. Three shipped error codes told the caller to restart at
 * `GET /auth/oauth/<provider>` while nothing anywhere ran the flow — so this asserts the path the
 * refusal names against the path the declaration mounts, never against a string this file repeats.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { OAuthFetch, OAuthLoginOptions } from '@ultimat3/auth';
import { authenticate, MemoryAdapter, readSessionCookie } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { AFTER_SIGN_IN, postlyAuth, postlyLogin } from './login';

const NOW = new Date('2026-08-15T12:00:00.000Z');
/** Before `NOW`: a member who proved the address on some earlier day, not during this login. */
const SIGNED_UP_AT = new Date('2026-07-01T09:00:00.000Z');
/** 32 bytes, the length `handshakeSecret` demands — never Postly's real `SESSION_SECRET`. */
const SECRET = 'postly-test-handshake-secret-000';
const ORIGIN = 'https://postly.test';
const CREDENTIALS = { clientId: 'postly-client-id', clientSecret: 'postly-client-secret' };

/**
 * There is no GitHub client id in CI and there never will be, so the provider is the one seam the
 * framework already hands a caller: the three calls a real login makes, answered in process. Every
 * other step — PKCE, the sealed handshake, the state check, the session — is the real code.
 */
const githubFetch: OAuthFetch = (input) => {
  if (input === 'https://github.com/login/oauth/access_token') {
    return Promise.resolve(Response.json({ access_token: 'gho_postly', token_type: 'bearer' }));
  }
  if (input === 'https://api.github.com/user') {
    return Promise.resolve(Response.json({ id: 4207, login: 'ada', name: 'Ada Lovelace' }));
  }
  if (input === 'https://api.github.com/user/emails') {
    return Promise.resolve(
      Response.json([{ email: 'ada@postly.test', primary: true, verified: true }]),
    );
  }
  return Promise.resolve(new Response('a call this login does not make', { status: 500 }));
};

/** Everything a caller is allowed to drive: the provider conversation, never the destination. */
const SEAMS = {
  credentials: CREDENTIALS,
  fetch: githubFetch,
  secret: SECRET,
  baseUrl: ORIGIN,
} as const;

let adapter: MemoryAdapter;
let auth: ReturnType<typeof postlyAuth>;
let login: ReturnType<typeof postlyLogin>;

beforeEach(() => {
  adapter = new MemoryAdapter();
  auth = postlyAuth({ adapter, clock: frozenClock(NOW) });
  login = postlyLogin(auth, SEAMS);
});

/** `/auth/oauth/:provider` → the URL a browser is actually sent to. The mount, filled in. */
const mounted = (pattern: string, provider: string): string =>
  pattern.replace(':provider', provider);

/** `name=value` — what a browser sends back, without the attributes it keeps to itself. */
const cookiePair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await response.json();
  expect(parsed).toBeObject();
  return parsed as Record<string, unknown>;
};

const startRequest = (provider: string): Request =>
  new Request(`${ORIGIN}${mounted(login.start.path, provider)}`);

/** Both legs against ONE set of routes: start, carry the sealed cookie, come back with its state. */
const roundTrip = async (routes: ReturnType<typeof postlyLogin>): Promise<Response> => {
  const start = await routes.start.handle(
    new Request(`${ORIGIN}${mounted(routes.start.path, 'github')}`),
  );
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  return await routes.callback.handle(
    new Request(
      `${ORIGIN}${mounted(routes.callback.path, 'github')}?code=the-code&state=${state}`,
      { headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') } },
    ),
  );
};

/**
 * Who the callback actually signed in, read back the only way a browser could: the cookie it set,
 * through the app's own `authenticate`. Without this a flow could "succeed" and sign nobody in.
 */
const signedInId = async (done: Response): Promise<string> => {
  const session = new Request(ORIGIN, {
    headers: { cookie: done.headers.getSetCookie().map(cookiePair).join('; ') },
  });
  const token = readSessionCookie(session, auth.sessions.policy);
  expect(token).not.toBeNull();
  return (await authenticate(auth, token)).id;
};

/** A local member who proved `ada@postly.test` long before this login — the half `link` demands. */
const seedVerifiedMember = async (): Promise<string> => {
  const created = await adapter.createUser({
    id: 'usr-ada-local',
    email: 'ada@postly.test',
    // A password login exists for this member; the OAuth leg must join it, never replace it.
    passwordHash: 'argon2id$a-hash-this-test-never-sends-the-input-to',
    orgId: null,
    roles: ['member'],
    createdAt: SIGNED_UP_AT,
  });
  expect(await adapter.updateUser(created.id, { emailVerifiedAt: SIGNED_UP_AT })).not.toBeNull();
  return created.id;
};

describe('log in with GitHub', () => {
  test('the start leg leaves for github with a state and an S256 challenge', async () => {
    const response = await login.start.handle(startRequest('github'));

    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get('location') ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorize.searchParams.get('state')).not.toBe('');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).not.toBeNull();
    // The address GitHub sends the browser back to is Postly's own callback mount, not a literal.
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}${mounted(login.callback.path, 'github')}`,
    );
    // Sealed across the two requests, and readable by nothing in the page.
    const sealed = response.headers.getSetCookie();
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toContain('HttpOnly');
  });

  test('a forged state is refused, and its fix names a path this app mounts', async () => {
    const start = await login.start.handle(startRequest('github'));

    const done = await login.callback.handle(
      new Request(`${ORIGIN}${mounted(login.callback.path, 'github')}?code=c&state=forged`, {
        headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') },
      }),
    );

    expect(done.status).toBe(400);
    const body = await bodyOf(done);
    expect(body['code']).toBe('X_OAUTH_STATE_INVALID');

    // Axiom 4, checked as a round trip: the path the fix line tells the caller to restart at has
    // to be one this app's own start descriptor claims. A literal here would pass while the mount
    // moved out from under it, which is exactly how three fix lines outlived their route.
    const named = /GET (\/\S+)/.exec(String(body['fix']))?.[1] ?? '';
    expect(named).toBe(mounted(login.start.path, 'github'));

    // The code the handshake authorised is spent whether or not the callback succeeded.
    expect(done.headers.getSetCookie().some((c) => c.includes('=;'))).toBe(true);
  });

  test('a completed login lands on Postly and mints a session Postly can authenticate', async () => {
    const done = await roundTrip(login);

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(AFTER_SIGN_IN);

    const user = await adapter.findUserByEmail('ada@postly.test');
    expect(await signedInId(done)).toBe(user?.id ?? '');
    // Nobody held this address, so the flow created the member — and `link: 'verified-email'` is
    // only safe on the NEXT login because the provider's assertion is recorded on this one.
    expect(user?.emailVerifiedAt).toEqual(NOW);
    expect(user?.passwordHash).toBeNull();
    expect(await adapter.findAccount('github', '4207')).not.toBeNull();
  });

  test('a verified local member is the same person, joined and not duplicated', async () => {
    const memberId = await seedVerifiedMember();

    const done = await roundTrip(login);

    // This is the whole of `link: 'verified-email'`: GitHub vouched for `ada@postly.test` and the
    // local row had proved it too, so the two identities are one member. Flip Postly's `link` to
    // `'never'` and this same request is a 401 X_UNAUTHENTICATED, not a 303.
    expect(done.status).toBe(303);
    expect(await signedInId(done)).toBe(memberId);
    expect((await adapter.findAccount('github', '4207'))?.userId).toBe(memberId);
    // One member, joined in place: no second row, and the login it already had is untouched.
    expect((await adapter.findUserByEmail('ada@postly.test'))?.id).toBe(memberId);
    const member = await adapter.findUserById(memberId);
    expect(member?.emailVerifiedAt).toEqual(SIGNED_UP_AT);
    expect(member?.passwordHash).not.toBeNull();
  });

  test('a caller cannot move where a signed-in browser lands', async () => {
    // `successPath` is absent from `PostlyLoginOptions`, so this is the framework's wider option
    // bag — the shape `postlyLogin` accepted before the destination was Postly's alone. The
    // override is dropped either way, because the spread applies AFTER the caller's seams.
    const hijacked: OAuthLoginOptions = { ...SEAMS, successPath: 'https://evil.test/session' };

    const done = await roundTrip(postlyLogin(auth, hijacked));

    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(AFTER_SIGN_IN);
  });

  test('a provider Postly never enabled never reaches a provider', async () => {
    const response = await login.start.handle(startRequest('google'));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('X_OAUTH_PROVIDER_UNKNOWN');
    expect(response.headers.get('location')).toBeNull();
  });
});
