import { describe, expect, test } from 'bun:test';
import { AuthError } from './errors';
import {
  assertOAuthCallback,
  beginOAuth,
  OAUTH_PROVIDERS,
  type OAuthHandshake,
  pkceChallenge,
} from './oauth';

const handshake = (): OAuthHandshake =>
  beginOAuth({
    provider: 'github',
    clientId: 'client-id',
    redirectUri: 'https://app.test/auth/callback',
  });

const codeOf = (error: unknown): string =>
  error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;

describe('oauth', () => {
  test('the S256 challenge matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  test('beginOAuth builds an authorize URL with PKCE and touches no network', () => {
    const url = new URL(handshake().authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length).toBe(43);
    expect(url.searchParams.get('client_id')).toBe('client-id');
  });

  test('a callback whose state does not match is rejected', () => {
    const stored = handshake();
    let thrown: unknown;
    try {
      assertOAuthCallback(stored, { state: 'attacker-supplied-state', code: 'abc' });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a callback with no PKCE verifier is rejected even when the state matches', () => {
    const stored = handshake();
    const withoutVerifier: OAuthHandshake = { ...stored, verifier: '' };
    let thrown: unknown;
    try {
      assertOAuthCallback(withoutVerifier, { state: stored.state, code: 'abc' });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('X_OAUTH_STATE_INVALID');
    expect((thrown as AuthError).cause).toContain('PKCE');
  });

  test('a matching state plus a stored verifier passes', () => {
    const stored = handshake();
    expect(() => assertOAuthCallback(stored, { state: stored.state, code: 'abc' })).not.toThrow();
  });

  test('every shipped provider requires PKCE and declares its env vars', () => {
    for (const provider of Object.values(OAUTH_PROVIDERS)) {
      expect(provider.usesPkce).toBe(true);
      expect(provider.clientIdEnv.endsWith('_CLIENT_ID')).toBe(true);
      expect(provider.clientSecretEnv.endsWith('_CLIENT_SECRET')).toBe(true);
    }
  });
});
