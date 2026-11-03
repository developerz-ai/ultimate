// A JWKS with no kid to go by: a published key without one, and a token without one. Split out of
// `jwks.test.ts` at the file ceiling.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { jwksClient, verifyJwtSignature } from './jwks';
import { base64Url } from './tokens';

const NOW = new Date('2026-08-16T12:00:00.000Z');

const clock = frozenClock(NOW);

const text = (value: string): string => base64Url(new TextEncoder().encode(value));

const rsaKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

const ecKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

const publicJwk = async (pair: CryptoKeyPair, kid: string): Promise<Record<string, unknown>> => ({
  ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  kid,
});

async function sign(
  pair: CryptoKeyPair,
  kid: string,
  alg: 'RS256' | 'ES256',
  claims: Readonly<Record<string, unknown>>,
): Promise<string> {
  const body = `${text(JSON.stringify({ alg, kid, typ: 'JWT' }))}.${text(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

/** One key set, served from memory, counting how many times it was actually asked for. */
const keySet = (jwks: readonly Record<string, unknown>[]) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ keys: jwks }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
};

const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

describe('a published key with no kid', () => {
  const unnamed = async (pair: CryptoKeyPair): Promise<Record<string, unknown>> => {
    const jwk = await publicJwk(pair, 'dropped');
    delete jwk['kid'];
    return jwk;
  };
  const noKidToken = async (pair: CryptoKeyPair): Promise<string> => {
    const body = `${text(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${text(JSON.stringify({ sub: 'ada' }))}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.privateKey,
      new TextEncoder().encode(body),
    );
    return `${body}.${base64Url(new Uint8Array(signature))}`;
  };
  const clientOf = (jwks: readonly Record<string, unknown>[]) =>
    jwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: keySet(jwks).fetch,
    });

  test('one kid-less key answers a kid-less token', async () => {
    const pair = await rsaKeyPair();
    const keys = clientOf([await unnamed(pair)]);
    expect(await verifyJwtSignature(await noKidToken(pair), keys)).toBe(true);
  });

  test('two kid-less keys are ambiguous, whichever one signed', async () => {
    const first = await rsaKeyPair();
    const second = await rsaKeyPair();
    const keys = clientOf([await unnamed(first), await unnamed(second)]);
    expect(await codeOf(async () => verifyJwtSignature(await noKidToken(second), keys))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('a kid-less key beside a named one is ambiguous too', async () => {
    const first = await rsaKeyPair();
    const second = await rsaKeyPair();
    const keys = clientOf([await unnamed(first), await publicJwk(second, 'k2')]);
    expect(await codeOf(async () => verifyJwtSignature(await noKidToken(first), keys))).toBe(
      'X_OAUTH_TOKEN_INVALID',
    );
  });

  test('a token naming a kid still needs that key: a kid-less one never answers it', async () => {
    const pair = await rsaKeyPair();
    const keys = clientOf([await unnamed(pair)]);
    const token = await sign(pair, 'k1', 'RS256', { sub: 'ada' });
    expect(await codeOf(() => verifyJwtSignature(token, keys))).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test('a kid-less set is not a refusal any more', async () => {
    const pair = await rsaKeyPair();
    const keys = clientOf([await unnamed(pair)]);
    expect(await keys.keyFor(null, 'RS256')).toBeDefined();
  });
});

describe('a token with no kid', () => {
  test('resolves when the set holds exactly one key for that algorithm', async () => {
    const pair = await rsaKeyPair();
    const jwk = await publicJwk(pair, 'k1');
    delete jwk['kid'];
    const served = keySet([{ ...(await publicJwk(pair, 'k1')) }]);
    const keys = jwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: served.fetch,
    });
    // The header carries no `kid`, so the only unambiguous answer is "the one RS256 key".
    const body = `${text(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${text(JSON.stringify({ sub: 'ada' }))}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.privateKey,
      new TextEncoder().encode(body),
    );
    const token = `${body}.${base64Url(new Uint8Array(signature))}`;

    expect(await verifyJwtSignature(token, keys)).toBe(true);
  });

  test('is refused when the set holds two keys for that algorithm — it names none of them', async () => {
    const first = await rsaKeyPair();
    const second = await rsaKeyPair();
    const served = keySet([await publicJwk(first, 'k1'), await publicJwk(second, 'k2')]);
    const keys = jwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: served.fetch,
    });
    const body = `${text(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${text(JSON.stringify({ sub: 'ada' }))}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      first.privateKey,
      new TextEncoder().encode(body),
    );
    const token = `${body}.${base64Url(new Uint8Array(signature))}`;

    // Picking one would be guessing which key an unauthenticated caller meant.
    expect(await codeOf(() => verifyJwtSignature(token, keys))).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test('an ES256 key in the same set does not answer for an RS256 token', async () => {
    const rsa = await rsaKeyPair();
    const ec = await ecKeyPair();
    const served = keySet([await publicJwk(rsa, 'k1'), await publicJwk(ec, 'k2')]);
    const keys = jwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: served.fetch,
    });
    // One RS256 key and one ES256 key: the RS256 lookup is unambiguous even with no `kid`.
    const body = `${text(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${text(JSON.stringify({ sub: 'ada' }))}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      rsa.privateKey,
      new TextEncoder().encode(body),
    );
    expect(await verifyJwtSignature(`${body}.${base64Url(new Uint8Array(signature))}`, keys)).toBe(
      true,
    );
  });
});
