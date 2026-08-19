// Split out of `jwks.test.ts` to stay under the 500-line ceiling `x verify`'s `filesize` step
// enforces. Two claims, both about what happens BEFORE a key is ever looked up: a token that is
// not a JWT is refused without an outbound request, and a provider that publishes no key set
// never becomes a source at all.

import { describe, expect, test } from 'bun:test';
import { AuthError } from './errors';
import { type JwksKeySource, providerJwks, verifyJwtSignature } from './jwks';
import { registerOAuthProvider } from './oauth-registry';
import { base64Url } from './tokens';

const text = (value: string): string => base64Url(new TextEncoder().encode(value));

describe('verifyJwtSignature refuses a token that is not a JWT at all', () => {
  const neverAsked: JwksKeySource = {
    keyFor: () => expect.unreachable('a malformed token must be refused before a key is looked up'),
  };

  test.each([
    ['two segments', 'aaa.bbb'],
    ['four segments', 'aaa.bbb.ccc.ddd'],
    ['one segment', 'aaa'],
    ['empty', ''],
  ])('%s is false, and no key is ever requested', async (_name, token) => {
    expect(await verifyJwtSignature(token, neverAsked)).toBe(false);
  });

  // A well-formed header, a payload, a signature AND a fourth segment: everything after the
  // segment count passes, so this is the only shape that pins the count check itself. A JWE is
  // five segments and would otherwise be handed to a JWS verifier.
  test('a valid header with a fourth segment appended is refused on the count alone', async () => {
    const header = text(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const payload = text(JSON.stringify({ sub: 'ada' }));
    const signature = text('signature-bytes');
    expect(await verifyJwtSignature(`${header}.${payload}.${signature}.extra`, neverAsked)).toBe(
      false,
    );
    expect(
      await verifyJwtSignature(`${header}.${payload}.${signature}.four.five`, neverAsked),
    ).toBe(false);
  });

  test('an empty signature segment is false rather than a verify against zero bytes', async () => {
    const header = text(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const payload = text(JSON.stringify({ sub: 'ada' }));
    expect(await verifyJwtSignature(`${header}.${payload}.`, neverAsked)).toBe(false);
    expect(await verifyJwtSignature(`${header}.${payload}.!!!not-base64url!!!`, neverAsked)).toBe(
      false,
    );
  });
});

describe('providerJwks', () => {
  test('a provider that publishes no jwks_uri is refused, naming both ways forward', () => {
    const github = registerOAuthProvider({
      id: 'jwks-no-keys-op',
      authorizeUrl: 'https://op.test/authorize',
      tokenUrl: 'https://op.test/token',
      userInfoUrl: 'https://op.test/userinfo',
      userEmailsUrl: null,
      issuers: [],
      jwksUri: null,
      scopes: ['read:user'],
      usesPkce: true,
      usesNonce: false,
      clientIdEnv: 'JWKS_NO_KEYS_OP_CLIENT_ID',
      clientSecretEnv: 'JWKS_NO_KEYS_OP_CLIENT_SECRET',
    });

    let caught: AuthError | null = null;
    try {
      providerJwks(github);
    } catch (error) {
      caught = error instanceof AuthError ? error : null;
    }
    expect(caught?.code).toBe('X_OAUTH_TOKEN_INVALID');
    expect(caught?.fix).toContain('register jwks-no-keys-op with an explicit jwksUri');
    expect(caught?.fix).toContain('exchangeOAuthCode()');
  });

  test('is memoised per provider id — the cache is the whole point of building one', () => {
    const provider = registerOAuthProvider({
      id: 'jwks-memo-op',
      authorizeUrl: 'https://op.test/authorize',
      tokenUrl: 'https://op.test/token',
      userInfoUrl: 'https://op.test/userinfo',
      userEmailsUrl: null,
      issuers: ['https://op.test'],
      jwksUri: 'https://op.test/jwks',
      scopes: ['openid'],
      usesPkce: true,
      usesNonce: true,
      clientIdEnv: 'JWKS_MEMO_OP_CLIENT_ID',
      clientSecretEnv: 'JWKS_MEMO_OP_CLIENT_SECRET',
    });

    // A client rebuilt per request refetches the key set per request, which is the bug.
    expect(providerJwks(provider)).toBe(providerJwks(provider));
  });
});
