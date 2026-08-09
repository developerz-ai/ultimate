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

  test('a narrowed scope set falls back to userinfo but keeps the verified subject', async () => {
    const withoutEmail = claims();
    const { email: _email, ...rest } = withoutEmail;
    const { fetch, urls } = routed({
      [GOOGLE_USERINFO]: () => json({ sub: 'someone-else', email: 'ada@example.com' }),
    });
    const profile = await oauthProfile('google', tokensWith(rest as IdTokenClaims), { fetch });
    expect(urls).toEqual([GOOGLE_USERINFO]);
    // The subject the token was verified for wins over anything the second call reports.
    expect(profile.providerAccountId).toBe('google-sub');
    expect(profile.email).toBe('ada@example.com');
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
    try {
      await oauthProfile('github', tokensWith(null), { fetch });
      throw new Error('unreachable');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
      expect(isUltimateError(error) && error.meta).toEqual({
        provider: 'github',
        stage: 'userinfo',
        status: 401,
      });
    }
  });

  test('a profile with no stable id is refused rather than keyed on an email', async () => {
    const { fetch } = routed({ [GITHUB_USER]: () => json({ email: 'ada@example.com' }) });
    try {
      await oauthProfile('github', tokensWith(null), { fetch });
      throw new Error('unreachable');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
      expect(isUltimateError(error) && error.cause).toContain('stable account id');
    }
  });

  test('a provider with neither claims nor a userinfo endpoint says so', async () => {
    try {
      await oauthProfile('apple', tokensWith(null));
      throw new Error('unreachable');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_OAUTH_EXCHANGE_FAILED');
      expect(isUltimateError(error) && error.cause).toContain('no userinfo endpoint');
    }
  });
});
