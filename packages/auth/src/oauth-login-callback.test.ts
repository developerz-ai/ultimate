// `completeOAuthLogin`: the second leg of the handshake — code to tokens to profile to session,
// against a fetch that answers each endpoint by name. `signInWithOAuth`'s own rules are
// `oauth-login.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Auth } from './auth';
import type { IdTokenClaims } from './id-token';
import { unsignedJwt } from './id-token-fixture';
import type { MemoryAdapter } from './memory-adapter';
import { beginOAuth, type OAuthHandshake } from './oauth';
import type { OAuthFetch } from './oauth-exchange';
import { completeOAuthLogin } from './oauth-login';
import { credentials, freshAuth, json, NOW } from './oauth-login-fixture';

let adapter: MemoryAdapter;
let auth: Auth;

beforeEach(() => {
  ({ adapter, auth } = freshAuth());
});

const googleIdToken = (handshake: OAuthHandshake): string => {
  const claims: IdTokenClaims = {
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    sub: 'google-sub',
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    nonce: handshake.nonce,
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
  };
  return unsignedJwt(claims);
};

describe('completeOAuthLogin', () => {
  test('a GitHub callback reaches a session in one call', async () => {
    const handshake = beginOAuth({
      provider: 'github',
      clientId: 'client-id',
      redirectUri: 'https://app.test/auth/callback',
    });
    // Every endpoint answered by name: a catch-all `return` handed a plausible email list to any
    // url the flow asked for, so a call to a fourth endpoint would have passed unnoticed.
    const urls: string[] = [];
    const fetch: OAuthFetch = async (url) => {
      urls.push(url);
      if (url === 'https://github.com/login/oauth/access_token') {
        return json({ access_token: 'gho_token', token_type: 'bearer' });
      }
      if (url === 'https://api.github.com/user') return json({ id: 583231, login: 'octocat' });
      if (url === 'https://api.github.com/user/emails') {
        return json([{ email: 'ada@example.com', primary: true, verified: true }]);
      }
      return expect.unreachable(`unexpected endpoint: ${url}`);
    };

    const result = await completeOAuthLogin(auth, {
      handshake,
      callback: { state: handshake.state, code: 'the-code' },
      credentials,
      fetch,
    });

    expect(urls).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user',
      'https://api.github.com/user/emails',
    ]);
    expect(result.actor.kind).toBe('user');
    expect((await adapter.findUserByEmail('ada@example.com'))?.id).toBe(result.actor.id);
    // The link exists; the provider credential does not. See `accountFor` in `oauth-login.ts`:
    // nothing ever read these columns back, and holding them made a database dump into a set of
    // usable third-party tokens.
    const linked = await adapter.findAccount('github', '583231');
    expect(linked?.providerAccountId).toBe('583231');
    expect(linked?.accessToken).toBeNull();
    expect(linked?.refreshToken).toBeNull();
  });

  test('a Google callback identifies from the id token alone', async () => {
    const handshake = beginOAuth({
      provider: 'google',
      clientId: 'client-id',
      redirectUri: 'https://app.test/auth/callback',
    });
    const urls: string[] = [];
    const fetch: OAuthFetch = async (url) => {
      urls.push(url);
      return json({ access_token: 'ya29.token', id_token: googleIdToken(handshake) });
    };

    const result = await completeOAuthLogin(auth, {
      handshake,
      callback: { state: handshake.state, code: 'the-code' },
      credentials,
      fetch,
    });

    expect(urls).toEqual(['https://oauth2.googleapis.com/token']);
    expect((await adapter.findAccount('google', 'google-sub'))?.userId).toBe(result.actor.id);
  });
});
