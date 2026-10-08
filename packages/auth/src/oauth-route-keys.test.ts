// `oauthLogin({ idTokenKeys })`: the callback route verifies a provider's id token signature
// against its published key set by default (26.0.0), and the option is the one place an app names
// another channel for a provider — asked per callback, with the provider's id.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, setLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { testSigner, unsignedJwt } from './id-token-fixture';
import type { IdTokenKeys } from './jwks';
import { memoryAuthAdapter } from './memory-adapter';
import type { OAuthProviderId } from './oauth';
import type { OAuthFetch } from './oauth-exchange';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const SECRET = 'a'.repeat(32);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const SIGNER = await testSigner();

let auth: Auth;

beforeEach(() => {
  auth = defineAuth({
    adapter: memoryAuthAdapter(),
    clock: frozenClock(NOW),
    providers: ['google'],
  });
});

const cookiePair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

/** One Google login through both legs, the token endpoint answering `mint(nonce)`. */
async function callback(
  mint: (nonce: string) => Promise<string> | string,
  idTokenKeys?: (provider: OAuthProviderId) => IdTokenKeys,
): Promise<Response> {
  let nonce = '';
  const fetch: OAuthFetch = async (url) =>
    url === GOOGLE_JWKS
      ? Response.json(SIGNER.jwks)
      : Response.json({ access_token: 'ya29.token', id_token: await mint(nonce) });
  const login = oauthLogin(auth, {
    credentials,
    fetch,
    secret: SECRET,
    baseUrl: 'https://app.test',
    ...(idTokenKeys === undefined ? {} : { idTokenKeys }),
  });
  const start = await login.start.handle(new Request('https://app.test/auth/oauth/google'));
  const authorize = new URL(start.headers.get('location') ?? '');
  nonce = authorize.searchParams.get('nonce') ?? '';
  return await login.callback.handle(
    new Request(
      `https://app.test/auth/oauth/google/callback?code=c&state=${authorize.searchParams.get('state')}`,
      { headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') } },
    ),
  );
}

const claims = (nonce: string) => ({
  iss: 'https://accounts.google.com',
  aud: 'client-id',
  sub: 'google-sub',
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  nonce,
  email: 'ada@example.com',
  email_verified: true,
});

describe('unit · oauthLogin verifies the id token signature', () => {
  test('signed by the published key: signed in', async () => {
    const done = await callback((nonce) => SIGNER.sign(claims(nonce)));
    expect(done.status).toBe(303);
  });

  test('a bad signature is refused 400 X_OAUTH_TOKEN_INVALID, and no session cookie is set', async () => {
    const previous = setLogSink(() => undefined);
    try {
      const done = await callback((nonce) => unsignedJwt(claims(nonce)));
      expect(done.status).toBe(400);
      expect(((await done.json()) as Record<string, unknown>)['code']).toBe(
        'X_OAUTH_TOKEN_INVALID',
      );
      // The only cookie set is the handshake's clear: no session was minted.
      const cookies = done.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    } finally {
      setLogSink(previous);
    }
  });

  test("idTokenKeys is asked per provider; 'token-endpoint-tls' opts that provider out", async () => {
    const asked: OAuthProviderId[] = [];
    const done = await callback(
      (nonce) => unsignedJwt(claims(nonce)),
      (provider) => {
        asked.push(provider);
        return 'token-endpoint-tls';
      },
    );
    expect(done.status).toBe(303);
    expect(asked).toEqual(['google']);
  });
});
