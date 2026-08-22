// One question, four call sites: does a coded refusal survive a `fetch` rejection the framework
// did not build? `fetch` is INJECTED on every OAuth path here, so the rejected value is whatever a
// driver, a proxy or a test double threw — and `value instanceof Error` runs the value's own
// `getPrototypeOf` trap, inside the catch block that has nothing left to answer with.
import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { createJwksClient } from './jwks';
import { beginOAuth } from './oauth';
import { discoverOAuthProvider } from './oauth-discovery';
import { exchangeOAuthCode, type OAuthFetch, type OAuthTokens } from './oauth-exchange';
import { oauthProfile } from './oauth-profile';

const clock = frozenClock(new Date('2026-08-09T12:00:00.000Z'));
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

/**
 * The value the four catch blocks must survive. `instanceof` consults `[[GetPrototypeOf]]`, so
 * this trap fires DURING the test that was meant to decide how to render it — a stranger with a
 * misbehaving egress proxy turns a 502-shaped refusal into an uncoded `TypeError`.
 */
const hostile = (): unknown =>
  new Proxy(new Error('unreachable'), {
    getPrototypeOf() {
      throw new TypeError('this value refuses to be classified');
    },
  });

const rejecting = (): OAuthFetch => () => Promise.reject(hostile());

/** The code, or what arrived instead — never a bare `Error` reporting the verdict. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

const tokensWithoutClaims = (): OAuthTokens => ({
  accessToken: 'the-access-token',
  refreshToken: null,
  expiresAt: null,
  idToken: null,
  claims: null,
});

describe('a fetch rejection that fights being classified', () => {
  test('the token exchange still answers X_OAUTH_EXCHANGE_FAILED', async () => {
    const handshake = beginOAuth({
      provider: 'github',
      clientId: 'client-id',
      redirectUri: 'https://app.test/auth/callback',
    });
    const failed = exchangeOAuthCode(
      handshake,
      { state: handshake.state, code: 'the-code' },
      { credentials, clock, fetch: rejecting() },
    );
    expect(await codeOf(failed)).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('the userinfo call still answers X_OAUTH_EXCHANGE_FAILED', async () => {
    const failed = oauthProfile('github', tokensWithoutClaims(), { fetch: rejecting() });
    expect(await codeOf(failed)).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('the JWKS fetch still answers X_OAUTH_EXCHANGE_FAILED', async () => {
    const client = createJwksClient({
      provider: 'bigco-sso',
      jwksUri: 'https://bigco.test/.well-known/jwks.json',
      fetch: rejecting(),
      clock,
    });
    expect(await codeOf(client.keyFor('any-kid', 'RS256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  test('discovery still answers X_OAUTH_EXCHANGE_FAILED', async () => {
    const failed = discoverOAuthProvider({
      id: 'bigco-sso',
      issuer: 'https://bigco.test',
      fetch: rejecting(),
    });
    expect(await codeOf(failed)).toBe('X_OAUTH_EXCHANGE_FAILED');
  });

  // A code alone is not the contract: the refusal is only useful if it was CONSTRUCTED, which is
  // what the escaping `TypeError` used to prevent — so the runnable `fix:` is the real assertion.
  test('the refusal still carries a runnable fix naming the URL', async () => {
    const failed = discoverOAuthProvider({
      id: 'bigco-sso',
      issuer: 'https://bigco.test',
      fetch: rejecting(),
    });
    const error: unknown = await failed.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!isUltimateError(error)) expect.unreachable('the hostile rejection escaped uncoded');
    expect(error.fix).toBe('curl -sS -m 5 https://bigco.test/.well-known/openid-configuration');
    expect(error.cause.length).toBeGreaterThan(20);
  });
});
