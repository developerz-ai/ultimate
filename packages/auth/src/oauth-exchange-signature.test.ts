// The id token's signature, on the default exchange: verified against the provider's published
// key set whenever it has one (26.0.0). Token-endpoint TLS alone (OIDC Core 3.1.3.7) is what a
// provider with no `jwks_uri` gets, or what a caller names explicitly.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { testSigner, unsignedJwt } from './id-token-fixture';
import { beginOAuth, type OAuthHandshake } from './oauth';
import { exchangeOAuthCode, type OAuthFetch } from './oauth-exchange';
import { registerOAuthProvider } from './oauth-registry';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

const claimsFor = (handshake: OAuthHandshake) => ({
  iss: 'https://accounts.google.com',
  aud: 'client-id',
  sub: 'google-sub',
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  nonce: handshake.nonce,
  email: 'ada@example.com',
  email_verified: true,
});

const handshakeFor = (provider: string): OAuthHandshake =>
  beginOAuth({ provider, clientId: 'client-id', redirectUri: 'https://app.test/auth/callback' });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** The token endpoint answers `idToken`; the key set URL answers `jwks`. Every URL is recorded. */
function provider(idToken: string, jwks: unknown, jwksUrl = GOOGLE_JWKS) {
  const urls: string[] = [];
  const fetch: OAuthFetch = async (url) => {
    urls.push(url);
    if (url === jwksUrl) return json(jwks);
    return json({ access_token: 'ya29.token', id_token: idToken });
  };
  return { fetch, urls };
}

const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  await call.then(
    (value) => expect.unreachable(`expected a rejection, resolved with ${String(value)}`),
    (error: unknown) => error,
  );

describe('unit · exchangeOAuthCode verifies the id token signature by default', () => {
  test("a token signed by the provider's published key verifies", async () => {
    const signer = await testSigner();
    const handshake = handshakeFor('google');
    const { fetch, urls } = provider(await signer.sign(claimsFor(handshake)), signer.jwks);
    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'c' },
      { credentials, clock, fetch },
    );
    expect(tokens.claims?.sub).toBe('google-sub');
    expect(urls).toEqual([GOOGLE_TOKEN, GOOGLE_JWKS]);
  });

  test('a token signed by any other key is X_OAUTH_TOKEN_INVALID, with a fix', async () => {
    const published = await testSigner();
    const forger = await testSigner();
    const handshake = handshakeFor('google');
    const { fetch } = provider(await forger.sign(claimsFor(handshake)), published.jwks);
    const error = await rejection(
      exchangeOAuthCode(
        handshake,
        { state: handshake.state, code: 'c' },
        { credentials, clock, fetch },
      ),
    );
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_TOKEN_INVALID');
    expect(isUltimateError(error) && error.cause).toContain('signature');
    expect(isUltimateError(error) && error.fix).not.toBe('');
  });

  test('an unsigned token is refused — the token endpoint is no longer trusted alone', async () => {
    const signer = await testSigner();
    const handshake = handshakeFor('google');
    const { fetch } = provider(unsignedJwt(claimsFor(handshake)), signer.jwks);
    const error = await rejection(
      exchangeOAuthCode(
        handshake,
        { state: handshake.state, code: 'c' },
        { credentials, clock, fetch },
      ),
    );
    expect(isUltimateError(error) && error.code).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test("keys: 'token-endpoint-tls' is the named opt-out: no key set is fetched", async () => {
    const handshake = handshakeFor('google');
    const { fetch, urls } = provider(unsignedJwt(claimsFor(handshake)), { keys: [] });
    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'c' },
      { credentials, clock, fetch, keys: 'token-endpoint-tls' },
    );
    expect(tokens.claims?.sub).toBe('google-sub');
    expect(urls).toEqual([GOOGLE_TOKEN]);
  });

  test('a registered provider with no jwks_uri falls back to token-endpoint TLS', async () => {
    registerOAuthProvider({
      id: 'sig-nokeys',
      authorizeUrl: 'https://nokeys.test/authorize',
      tokenUrl: 'https://nokeys.test/token',
      userInfoUrl: null,
      userEmailsUrl: null,
      issuers: ['https://nokeys.test'],
      jwksUri: null,
      scopes: ['openid', 'email'],
      usesPkce: true,
      usesNonce: true,
      clientIdEnv: 'NOKEYS_CLIENT_ID',
      clientSecretEnv: 'NOKEYS_CLIENT_SECRET',
    });
    const handshake = handshakeFor('sig-nokeys');
    const { fetch, urls } = provider(
      unsignedJwt({ ...claimsFor(handshake), iss: 'https://nokeys.test' }),
      { keys: [] },
    );
    const tokens = await exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'c' },
      { credentials, clock, fetch },
    );
    expect(tokens.claims?.iss).toBe('https://nokeys.test');
    expect(urls).toEqual(['https://nokeys.test/token']);
  });
});
