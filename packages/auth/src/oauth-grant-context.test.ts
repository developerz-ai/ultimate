// The grant seam's second argument (#670): an IdP that puts authorization facts on `/userinfo`
// only — never in the id token — must be readable from `resolveGrants`, or a correctly granted
// user is refused. The token set, the full id-token payload and a lazy, subject-checked userinfo.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Auth } from './auth';
import type { IdTokenClaims } from './id-token';
import { unsignedJwt } from './id-token-fixture';
import { beginOAuth, type OAuthProviderId } from './oauth';
import type { OAuthFetch } from './oauth-exchange';
import { type OAuthGrantContext, oauthGrantContext } from './oauth-grant-context';
import { completeOAuthLogin } from './oauth-login';
import { codeOf, credentials, freshAuth, json, NOW, profile, tokens } from './oauth-login-fixture';
import { registerOAuthProvider } from './oauth-registry';

let auth: Auth;

beforeEach(() => {
  ({ auth } = freshAuth());
});

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

interface Seen {
  readonly url: string;
  readonly authorization: string | null;
}

/** Google, answering by name: the token endpoint with an id token, and a userinfo body. */
const google = (userinfo: Readonly<Record<string, unknown>>) => {
  const handshake = beginOAuth({
    provider: 'google',
    clientId: 'client-id',
    redirectUri: 'https://app.test/auth/oauth/google/callback',
  });
  const claims: IdTokenClaims & { readonly hd: string } = {
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    sub: 'google-sub',
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    nonce: handshake.nonce,
    email: 'ada@example.com',
    email_verified: true,
    // A claim `IdTokenClaims` does not name — what an app's grant rule may well key on.
    hd: 'corp.example',
  };
  const seen: Seen[] = [];
  const fetch: OAuthFetch = async (url, init) => {
    seen.push({ url, authorization: new Headers(init.headers).get('authorization') });
    if (url === GOOGLE_TOKEN) {
      return json({ access_token: 'ya29.token', id_token: unsignedJwt(claims) });
    }
    if (url === GOOGLE_USERINFO) return json(userinfo);
    return expect.unreachable(`unexpected endpoint: ${url}`);
  };
  const login = (resolveGrants: Parameters<typeof completeOAuthLogin>[1]['resolveGrants']) =>
    completeOAuthLogin(auth, {
      handshake,
      callback: { state: handshake.state, code: 'the-code' },
      credentials,
      fetch,
      resolveGrants,
      // The seam, not the signature (`oauth-exchange-signature.test.ts`): the named opt-out keeps
      // this fixture's endpoint list to the two calls under test.
      idTokenKeys: 'token-endpoint-tls',
    });
  return { seen, login };
};

const allowedApps = (body: Readonly<Record<string, unknown>>): readonly string[] => {
  const apps = body['allowed_oauth_apps'];
  return Array.isArray(apps) ? apps.filter((app): app is string => typeof app === 'string') : [];
};

describe('resolveGrants sees what the IdP said, not only the profile', () => {
  test('a grant that lives on /userinfo only reaches the seam, read with the access token', async () => {
    const { seen, login } = google({
      sub: 'google-sub',
      allowed_oauth_apps: ['bank-integrations'],
    });
    const result = await login(async (_profile, context) => {
      const allowed = allowedApps(await context.userinfo()).includes('bank-integrations');
      return { orgId: allowed ? 'org-1' : null, roles: allowed ? ['member'] : [] };
    });

    expect(result.actor.roles).toEqual(['member']);
    expect(result.actor.orgId).toBe('org-1');
    expect(seen).toEqual([
      { url: GOOGLE_TOKEN, authorization: null },
      { url: GOOGLE_USERINFO, authorization: 'Bearer ya29.token' },
    ]);
  });

  test('the token set and the whole verified id-token payload ride along', async () => {
    let captured: OAuthGrantContext | undefined;
    const { login } = google({ sub: 'google-sub' });
    await login((_profile, context) => {
      captured = context;
      return {};
    });

    expect(captured?.provider).toBe('google');
    expect(captured?.tokens.accessToken).toBe('ya29.token');
    expect(captured?.tokens.claims?.sub).toBe('google-sub');
    expect(captured?.idTokenClaims?.['hd']).toBe('corp.example');
  });

  test('userinfo is fetched only when asked, and once however often it is asked', async () => {
    const unused = google({ sub: 'google-sub' });
    await unused.login(() => ({}));
    expect(unused.seen.map((call) => call.url)).toEqual([GOOGLE_TOKEN]);

    const twice = google({ sub: 'google-sub', allowed_oauth_apps: [] });
    await twice.login(async (_profile, context) => {
      const [a, b] = await Promise.all([context.userinfo(), context.userinfo()]);
      expect(a).toBe(b);
      return {};
    });
    expect(twice.seen.map((call) => call.url)).toEqual([GOOGLE_TOKEN, GOOGLE_USERINFO]);
  });

  test("a userinfo naming another subject is not this identity's, and mints no session", async () => {
    const { login } = google({ sub: 'someone-else', allowed_oauth_apps: ['bank-integrations'] });
    const grantsFromUserinfo = async (_p: unknown, context: OAuthGrantContext) => {
      await context.userinfo();
      return { roles: ['admin'] };
    };
    expect(await codeOf(login(grantsFromUserinfo))).toBe('X_OAUTH_EXCHANGE_FAILED');
  });
});

describe('a profile that was read off userinfo is not read twice', () => {
  test('GitHub: userinfo() returns the body the profile came from, with zero extra fetches', async () => {
    const handshake = beginOAuth({
      provider: 'github',
      clientId: 'client-id',
      redirectUri: 'https://app.test/auth/oauth/github/callback',
    });
    const urls: string[] = [];
    const fetch: OAuthFetch = async (url) => {
      urls.push(url);
      if (url === 'https://github.com/login/oauth/access_token') {
        return json({ access_token: 'gho_token', token_type: 'bearer' });
      }
      if (url === 'https://api.github.com/user') {
        return json({ id: 583231, login: 'octocat', site_admin: false });
      }
      if (url === 'https://api.github.com/user/emails') {
        return json([{ email: 'ada@example.com', primary: true, verified: true }]);
      }
      return expect.unreachable(`unexpected endpoint: ${url}`);
    };
    let login: unknown;
    await completeOAuthLogin(auth, {
      handshake,
      callback: { state: handshake.state, code: 'the-code' },
      credentials,
      fetch,
      resolveGrants: async (_profile, context) => {
        login = (await context.userinfo())['login'];
        return {};
      },
    });

    expect(login).toBe('octocat');
    expect(urls).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user',
      'https://api.github.com/user/emails',
    ]);
  });
});

describe('oauthGrantContext', () => {
  const context = (provider: OAuthProviderId, fetch: OAuthFetch) =>
    oauthGrantContext(profile({ provider, providerAccountId: '583231' }), tokens(), { fetch });

  test('a provider with no userinfo endpoint refuses with a coded error, before any socket', async () => {
    const fetch: OAuthFetch = async (url) => expect.unreachable(`no request expected: ${url}`);
    const claimsOnly = registerOAuthProvider({
      id: 'claims-only-grant-op',
      authorizeUrl: 'https://claims.test/authorize',
      tokenUrl: 'https://claims.test/token',
      // Claims in the id token only: no userinfo endpoint to call.
      userInfoUrl: null,
      userEmailsUrl: null,
      issuers: ['https://claims.test'],
      jwksUri: 'https://claims.test/keys',
      scopes: ['openid', 'email'],
      usesPkce: true,
      usesNonce: true,
      clientIdEnv: 'CLAIMS_ONLY_CLIENT_ID',
      clientSecretEnv: 'CLAIMS_ONLY_CLIENT_SECRET',
    });
    expect(await codeOf(context(claimsOnly.id, fetch).userinfo())).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test("GitHub's numeric id is its subject, and a failed read is coded, never cached", async () => {
    let answer: Response = new Response('nope', { status: 503 });
    const fetch: OAuthFetch = async () => answer;
    const github = context('github', fetch);
    expect(await codeOf(github.userinfo())).toBe('X_OAUTH_EXCHANGE_FAILED');
    answer = json({ id: 583231, login: 'octocat' });
    expect((await github.userinfo())['login']).toBe('octocat');
  });

  test('no id token is no id-token payload', () => {
    const fetch: OAuthFetch = async (url) => expect.unreachable(`no request expected: ${url}`);
    expect(context('github', fetch).idTokenClaims).toBeNull();
  });
});
