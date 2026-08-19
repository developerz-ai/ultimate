import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { IdTokenClaims } from './id-token';
import type { OAuthFetch, OAuthTokens } from './oauth-exchange';
import { oauthProfile } from './oauth-profile';

const claims = (overrides: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
  iss: 'https://accounts.google.com',
  aud: 'client-id',
  sub: 'google-sub',
  exp: 4_102_444_800,
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada Lovelace',
  ...overrides,
});

/** The narrowed-scope case: a subject the exchange verified, and no address anywhere in it. */
const claimsWithoutEmail = (): IdTokenClaims => {
  const { email: _email, ...rest } = claims();
  return rest;
};

const tokensWith = (idClaims: IdTokenClaims | null): OAuthTokens => ({
  accessToken: 'the-access-token',
  refreshToken: null,
  expiresAt: null,
  idToken: idClaims === null ? null : 'header.payload.signature',
  claims: idClaims,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const routed = (
  routes: Readonly<Record<string, () => Response>>,
): { fetch: OAuthFetch; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const route = routes[url];
      if (route === undefined) return json({ message: 'unrouted' }, 404);
      return await Promise.resolve(route());
    },
  };
};

/**
 * The rejected value itself. A `throw new Error('unreachable')` inside a try/catch lands in its
 * own catch, so a call that wrongly *resolved* used to be reported as a mismatched boolean.
 */
const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  await call.then(
    (value) => expect.unreachable(`expected a rejection, resolved with ${String(value)}`),
    (error: unknown) => error,
  );

const GITHUB_USER = 'https://api.github.com/user';
const GITHUB_EMAILS = 'https://api.github.com/user/emails';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

describe('oauthProfile', () => {
  test('a verified id token identifies the user with no second round trip', async () => {
    const { fetch, urls } = routed({});
    const profile = await oauthProfile('google', tokensWith(claims()), { fetch });
    expect(profile).toEqual({
      provider: 'google',
      providerAccountId: 'google-sub',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    expect(urls).toHaveLength(0);
  });

  test('an unverified address is carried as unverified, never rounded up', async () => {
    const profile = await oauthProfile('google', tokensWith(claims({ email_verified: false })));
    expect(profile.emailVerified).toBe(false);
  });

  test('a narrowed scope set falls back to userinfo for the address the token omitted', async () => {
    const { fetch, urls } = routed({
      [GOOGLE_USERINFO]: () => json({ sub: 'google-sub', email: 'ada@example.com' }),
    });
    const profile = await oauthProfile('google', tokensWith(claimsWithoutEmail()), { fetch });
    expect(urls).toEqual([GOOGLE_USERINFO]);
    expect(profile.providerAccountId).toBe('google-sub');
    expect(profile.email).toBe('ada@example.com');
  });

  test('a userinfo subject that disagrees with the verified id token ends the handshake', async () => {
    const { fetch } = routed({
      // Overwriting the subject and keeping this address would link the account on an address
      // the verified token never vouched for — whoever `someone-else` is.
      [GOOGLE_USERINFO]: () => json({ sub: 'someone-else', email: 'attacker@example.com' }),
    });
    const error = await rejection(
      oauthProfile('google', tokensWith(claimsWithoutEmail()), { fetch }),
    );
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.meta).toEqual({ provider: 'google', stage: 'userinfo' });
    expect(isUltimateError(error) && error.cause).toContain('not the subject of the verified');
  });

  test("GitHub's numeric id becomes the account id, and the verified primary wins", async () => {
    const { fetch, urls } = routed({
      [GITHUB_USER]: () => json({ id: 583231, login: 'octocat', email: null, name: 'The Octocat' }),
      [GITHUB_EMAILS]: () =>
        json([
          { email: 'octocat@users.noreply.github.com', primary: false, verified: true },
          { email: 'ada@example.com', primary: true, verified: true },
        ]),
    });
    const profile = await oauthProfile('github', tokensWith(null), { fetch });
    expect(urls).toEqual([GITHUB_USER, GITHUB_EMAILS]);
    expect(profile).toEqual({
      provider: 'github',
      providerAccountId: '583231',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'The Octocat',
    });
  });

  test('an unverified GitHub address is never treated as proof of the address', async () => {
    const { fetch } = routed({
      [GITHUB_USER]: () => json({ id: 1, login: 'octocat', email: 'public@example.com' }),
      [GITHUB_EMAILS]: () => json([{ email: 'ada@example.com', primary: true, verified: false }]),
    });
    const profile = await oauthProfile('github', tokensWith(null), { fetch });
    expect(profile.email).toBe('public@example.com');
    expect(profile.emailVerified).toBe(false);
  });

  test('a missing user:email scope degrades to the public address instead of failing', async () => {
    const { fetch } = routed({
      [GITHUB_USER]: () => json({ id: 1, login: 'octocat', email: 'public@example.com' }),
      [GITHUB_EMAILS]: () => json({ message: 'Requires authentication' }, 403),
    });
    const profile = await oauthProfile('github', tokensWith(null), { fetch });
    expect(profile.email).toBe('public@example.com');
    expect(profile.emailVerified).toBe(false);
  });

  test('a refused profile call is X_OAUTH_EXCHANGE_FAILED at the userinfo stage', async () => {
    const { fetch } = routed({ [GITHUB_USER]: () => json({ message: 'Bad credentials' }, 401) });
    const error = await rejection(oauthProfile('github', tokensWith(null), { fetch }));
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.meta).toEqual({
      provider: 'github',
      stage: 'userinfo',
      status: 401,
    });
  });

  test('a profile with no stable id is refused rather than keyed on an email', async () => {
    const { fetch } = routed({ [GITHUB_USER]: () => json({ email: 'ada@example.com' }) });
    const error = await rejection(oauthProfile('github', tokensWith(null), { fetch }));
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.cause).toContain('stable account id');
  });

  test('a provider with neither claims nor a userinfo endpoint says so', async () => {
    const error = await rejection(oauthProfile('apple', tokensWith(null)));
    expect(isUltimateError(error)).toBe(true);
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.cause).toContain('no userinfo endpoint');
  });
});

describe('the userinfo call, when it does not come back', () => {
  // Distinct from a 4xx: `fetch` REJECTS on DNS failure, a refused connection or the abort — no
  // status exists, and the naked rejection would escape every coded path in this package.
  test('a rejected fetch names the host that never answered and the curl that checks it', async () => {
    const error = await rejection(
      oauthProfile('google', tokensWith(claimsWithoutEmail()), {
        fetch: async () => {
          throw new TypeError('Unable to connect. Is the computer able to access the url?');
        },
      }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.meta).toEqual({ provider: 'google', stage: 'userinfo' });
    expect(isUltimateError(error) && error.cause).toContain('Unable to connect');
    expect(isUltimateError(error) && error.cause).toContain('egress, DNS or TLS');
    expect(isUltimateError(error) && error.fix).toContain(
      `curl -sS -m 5 -o /dev/null ${GOOGLE_USERINFO}`,
    );
  });

  test('a rejection that is not an Error still gets a sentence, never [object Object]', async () => {
    const error = await rejection(
      oauthProfile('google', tokensWith(claimsWithoutEmail()), {
        fetch: async () => {
          throw { name: 'AbortError' } as unknown as Error;
        },
      }),
    );
    expect(isUltimateError(error) && error.cause).toContain('the request failed before a response');
    expect(isUltimateError(error) && error.cause).not.toContain('[object Object]');
  });

  test('a 200 whose body is not a JSON object is refused, not read as an empty profile', async () => {
    const { fetch } = routed({
      // A proxy or a captive portal answering 200 with something that is not a profile.
      [GOOGLE_USERINFO]: () => json(['sub', 'google-sub']),
    });
    const error = await rejection(
      oauthProfile('google', tokensWith(claimsWithoutEmail()), { fetch }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.cause).toContain('not a JSON object');
    expect(isUltimateError(error) && error.fix).toContain(GOOGLE_USERINFO);
  });

  test('a 200 that is not JSON at all is the same refusal, never a bare SyntaxError', async () => {
    const error = await rejection(
      oauthProfile('google', tokensWith(claimsWithoutEmail()), {
        fetch: async () =>
          new Response('<!doctype html><title>Sign in</title>', {
            headers: { 'content-type': 'text/html' },
          }),
      }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(isUltimateError(error) && error.cause).toContain('not a JSON object');
  });
});
