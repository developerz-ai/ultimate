import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { decodeIdToken, idTokenEmailVerified, isVerifiedFlag, verifyIdToken } from './id-token';
import { unsignedJwt } from './id-token-fixture';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);
const seconds = (offsetMs: number): number => Math.floor((NOW.getTime() + offsetMs) / 1000);

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

const asyncCodeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

/**
 * `keys: 'token-endpoint-tls'` on every call here on purpose: these fixtures carry no real
 * signature, and this describe block is about the CLAIM checks. The signature path is
 * `jwks.test.ts`, where a forged token is refused against a real key set.
 */
const verify = async (idToken: string, nonce = 'stored-nonce'): Promise<unknown> =>
  await verifyIdToken({
    provider: 'google',
    idToken,
    clientId: 'client-id',
    nonce,
    clock,
    keys: 'token-endpoint-tls',
  });

describe('decodeIdToken', () => {
  test('reads the claims this package acts on, including non-ASCII names', () => {
    const claims = decodeIdToken('google', unsignedJwt(googleClaims({ name: 'Ada Lovelace 👑' })));
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
      expect(codeOf(() => decodeIdToken('google', unsignedJwt(claims)))).toBe(
        'X_OAUTH_TOKEN_INVALID',
      );
    }
  });

  test('an aud claim that names nobody is rejected, never carried as an empty audience', () => {
    // Both used to survive: `[]` is an array, and `[1, 2]` becomes `[]` once the non-strings are
    // filtered out. `verifyIdToken` then checked this handshake's client id against nothing.
    for (const aud of [[], [1, 2]]) {
      expect(codeOf(() => decodeIdToken('google', unsignedJwt(googleClaims({ aud }))))).toBe(
        'X_OAUTH_TOKEN_INVALID',
      );
    }
  });

  test('email_verified counts only as a real boolean or the string Apple sends', () => {
    expect(idTokenEmailVerified(decodeIdToken('google', unsignedJwt(googleClaims())))).toBe(true);
    const asString = decodeIdToken('apple', unsignedJwt(googleClaims({ email_verified: 'true' })));
    expect(idTokenEmailVerified(asString)).toBe(true);
    const asFalse = decodeIdToken('google', unsignedJwt(googleClaims({ email_verified: 'false' })));
    expect(idTokenEmailVerified(asFalse)).toBe(false);
    const absent = googleClaims();
    delete absent['email_verified'];
    expect(idTokenEmailVerified(decodeIdToken('google', unsignedJwt(absent)))).toBe(false);
  });
});

describe('isVerifiedFlag', () => {
  test('is the one rule both the id token and userinfo are read through', () => {
    expect([true, 'true'].map((value) => isVerifiedFlag(value))).toEqual([true, true]);
    // Nothing else rounds up — least of all a truthy string or the number 1.
    for (const value of [false, 'false', 'TRUE', 1, '1', null, undefined, {}]) {
      expect(isVerifiedFlag(value)).toBe(false);
    }
  });
});

describe('verifyIdToken', () => {
  test('accepts both issuer spellings Google has shipped', async () => {
    expect(await asyncCodeOf(() => verify(unsignedJwt(googleClaims())))).toBe('did-not-throw');
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ iss: 'accounts.google.com' })))),
    ).toBe('did-not-throw');
  });

  test('an issuer the provider never claims is rejected', async () => {
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ iss: 'https://evil.test' })))),
    ).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test('aud may be an array, and must contain this handshake client id', async () => {
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ aud: ['other', 'client-id'] })))),
    ).toBe('did-not-throw');
    expect(await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ aud: 'another-app' }))))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('an expired token is rejected, and one inside the skew window is not', async () => {
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ exp: seconds(-120_000) })))),
    ).toBe('X_OAUTH_TOKEN_INVALID');
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ exp: seconds(-30_000) })))),
    ).toBe('did-not-throw');
  });

  test('a nonce from another browser is X_OAUTH_STATE_INVALID, not a token error', async () => {
    // Same class of event as a forged `state`: a token minted elsewhere, replayed here.
    expect(
      await asyncCodeOf(() => verify(unsignedJwt(googleClaims({ nonce: 'someone-elses-nonce' })))),
    ).toBe('X_OAUTH_STATE_INVALID');
    const withoutNonce = googleClaims();
    delete withoutNonce['nonce'];
    expect(await asyncCodeOf(() => verify(unsignedJwt(withoutNonce)))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });

  test('a provider that issues no id token can never have one accepted for it', async () => {
    const asGithub = async (): Promise<unknown> =>
      await verifyIdToken({
        provider: 'github',
        idToken: unsignedJwt(googleClaims()),
        clientId: 'client-id',
        nonce: 'stored-nonce',
        clock,
        keys: 'token-endpoint-tls',
      });
    expect(await asyncCodeOf(asGithub)).toBe('X_OAUTH_TOKEN_INVALID');
  });
});

/**
 * `claims.iss` is a field of the JWT the caller just presented. It reached the refusal wrapped in
 * hand-written quotes, which escape nothing — so a forged `iss` could close the sentence and add
 * a line of its own to the log.
 */
describe('a forged iss cannot forge a log line', () => {
  test('the rejected issuer is rendered, not interpolated', async () => {
    const hostile = 'https://evil.test"\n2026-08-16 level=info msg="issuer ok';
    const thrown = await verifyIdToken({
      provider: 'google',
      idToken: unsignedJwt(googleClaims({ iss: hostile })),
      clientId: 'client-id',
      nonce: 'stored-nonce',
      clock,
      keys: 'token-endpoint-tls',
    }).catch((error: unknown) => error);

    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_TOKEN_INVALID');
    expect(error?.cause).not.toContain('\n');
    expect(error?.cause).toContain('\\n');
    // Still readable: the operator can see which issuer was presented.
    expect(error?.cause).toContain('evil.test');
  });
});
