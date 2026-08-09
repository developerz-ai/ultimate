import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { decodeIdToken, idTokenEmailVerified, verifyIdToken } from './id-token';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);
const seconds = (offsetMs: number): number => Math.floor((NOW.getTime() + offsetMs) / 1000);

const base64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const jwt = (claims: Record<string, unknown>): string =>
  `${base64Url('{"alg":"RS256"}')}.${base64Url(JSON.stringify(claims))}.signature`;

const googleClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://accounts.google.com',
  aud: 'client-id',
  sub: '108122122550',
  exp: seconds(3_600_000),
  nonce: 'stored-nonce',
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada Lovelace',
  ...overrides,
});

const codeOf = (call: () => unknown): string => {
  try {
    call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

const verify = (idToken: string, nonce = 'stored-nonce'): unknown =>
  verifyIdToken({ provider: 'google', idToken, clientId: 'client-id', nonce, clock });

describe('decodeIdToken', () => {
  test('reads the claims this package acts on, including non-ASCII names', () => {
    const claims = decodeIdToken('google', jwt(googleClaims({ name: 'Ada Lovelace 👑' })));
    expect(claims.sub).toBe('108122122550');
    expect(claims.email).toBe('ada@example.com');
    expect(claims.name).toBe('Ada Lovelace 👑');
    expect(claims.exp).toBe(seconds(3_600_000));
  });

  test('a token that is not three segments is X_OAUTH_TOKEN_INVALID', () => {
    expect(codeOf(() => decodeIdToken('google', 'not.a-jwt'))).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test('a payload that is not base64url JSON is rejected rather than guessed at', () => {
    expect(codeOf(() => decodeIdToken('google', 'aGVhZGVy.$$$$.sig'))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('a payload missing iss, sub, aud or a numeric exp is rejected', () => {
    for (const missing of ['iss', 'sub', 'aud', 'exp'] as const) {
      const claims = googleClaims();
      delete claims[missing];
      expect(codeOf(() => decodeIdToken('google', jwt(claims)))).toBe('X_OAUTH_TOKEN_INVALID');
    }
  });

  test('email_verified counts only as a real boolean or the string Apple sends', () => {
    expect(idTokenEmailVerified(decodeIdToken('google', jwt(googleClaims())))).toBe(true);
    const asString = decodeIdToken('apple', jwt(googleClaims({ email_verified: 'true' })));
    expect(idTokenEmailVerified(asString)).toBe(true);
    const asFalse = decodeIdToken('google', jwt(googleClaims({ email_verified: 'false' })));
    expect(idTokenEmailVerified(asFalse)).toBe(false);
    const absent = googleClaims();
    delete absent['email_verified'];
    expect(idTokenEmailVerified(decodeIdToken('google', jwt(absent)))).toBe(false);
  });
});

describe('verifyIdToken', () => {
  test('accepts both issuer spellings Google has shipped', () => {
    expect(() => verify(jwt(googleClaims()))).not.toThrow();
    expect(() => verify(jwt(googleClaims({ iss: 'accounts.google.com' })))).not.toThrow();
  });

  test('an issuer the provider never claims is rejected', () => {
    expect(codeOf(() => verify(jwt(googleClaims({ iss: 'https://evil.test' }))))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('aud may be an array, and must contain this handshake client id', () => {
    expect(() => verify(jwt(googleClaims({ aud: ['other', 'client-id'] })))).not.toThrow();
    expect(codeOf(() => verify(jwt(googleClaims({ aud: 'another-app' }))))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('an expired token is rejected, and one inside the skew window is not', () => {
    expect(codeOf(() => verify(jwt(googleClaims({ exp: seconds(-120_000) }))))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
    expect(() => verify(jwt(googleClaims({ exp: seconds(-30_000) })))).not.toThrow();
  });

  test('a nonce from another browser is X_OAUTH_STATE_INVALID, not a token error', () => {
    expect(codeOf(() => verify(jwt(googleClaims({ nonce: 'someone-elses-nonce' })))))
      // Same class of event as a forged `state`: a token minted elsewhere, replayed here.
      .toBe('X_OAUTH_STATE_INVALID');
    const withoutNonce = googleClaims();
    delete withoutNonce['nonce'];
    expect(codeOf(() => verify(jwt(withoutNonce)))).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a provider that issues no id token can never have one accepted for it', () => {
    const asGithub = (): unknown =>
      verifyIdToken({
        provider: 'github',
        idToken: jwt(googleClaims()),
        clientId: 'client-id',
        nonce: 'stored-nonce',
        clock,
      });
    expect(codeOf(asGithub)).toBe('X_OAUTH_TOKEN_INVALID');
  });
});
