// The failure case first: a JWT nobody signed, carrying a real issuer, this app's audience and a
// victim's `sub`, must be refused. Before `jwks.ts` existed there was nothing between such a token
// and `signInWithOAuth` except the assumption that every id token arrived over TLS from the token
// endpoint — an assumption the first IdP-initiated login or `response_mode=form_post` breaks.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { verifyIdToken } from './id-token';
import { createJwksClient, decodeJwtHeader, verifyJwtSignature } from './jwks';
import { registerOAuthProvider } from './oauth-registry';
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

describe('verifyJwtSignature', () => {
  test('a token minted by someone who does not hold the key is refused', async () => {
    const real = await rsaKeyPair();
    const attacker = await rsaKeyPair();
    const served = keySet([await publicJwk(real, 'k1')]);
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      fetch: served.fetch,
      clock,
    });

    const forged = await sign(attacker, 'k1', 'RS256', { sub: 'the-vp', iss: 'https://op.test' });
    expect(await verifyJwtSignature(forged, keys)).toBe(false);

    const genuine = await sign(real, 'k1', 'RS256', { sub: 'ada', iss: 'https://op.test' });
    expect(await verifyJwtSignature(genuine, keys)).toBe(true);
  });

  test('a payload edited after signing no longer verifies', async () => {
    const pair = await rsaKeyPair();
    const served = keySet([await publicJwk(pair, 'k1')]);
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      fetch: served.fetch,
      clock,
    });
    const token = await sign(pair, 'k1', 'RS256', { sub: 'ada' });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${text(JSON.stringify({ sub: 'the-vp' }))}.${signature}`;
    expect(await verifyJwtSignature(tampered, keys)).toBe(false);
  });

  test('ES256 verifies, so an Apple-shaped key set is not a special case', async () => {
    const pair = await ecKeyPair();
    const served = keySet([await publicJwk(pair, 'ec1')]);
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      fetch: served.fetch,
      clock,
    });
    expect(await verifyJwtSignature(await sign(pair, 'ec1', 'ES256', { sub: 'ada' }), keys)).toBe(
      true,
    );
  });

  test('alg: none and alg: HS256 are refused before a key is ever looked up', async () => {
    const keys: { keyFor: () => Promise<CryptoKey> } = {
      keyFor: () => {
        throw new Error('a key must never be requested for an unsupported alg');
      },
    };
    for (const alg of ['none', 'HS256', 'RS512']) {
      const token = `${text(JSON.stringify({ alg }))}.${text('{"sub":"the-vp"}')}.sig`;
      expect(await verifyJwtSignature(token, keys)).toBe(false);
    }
  });

  test('a header that is not base64url JSON is null, never a throw', () => {
    expect(decodeJwtHeader('$$$$')).toBeNull();
    expect(decodeJwtHeader(text('not json'))).toBeNull();
    expect(decodeJwtHeader(text('{"alg":"RS256"}'))).toEqual({ alg: 'RS256', kid: null });
  });
});

describe('the JWKS cache', () => {
  test('a second token on the same kid is served from cache; a new kid refetches once', async () => {
    const first = await rsaKeyPair();
    const second = await rsaKeyPair();
    let jwks = [await publicJwk(first, 'k1')];
    let calls = 0;
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ keys: jwks }));
      },
    });

    expect(await verifyJwtSignature(await sign(first, 'k1', 'RS256', { sub: 'a' }), keys)).toBe(
      true,
    );
    expect(await verifyJwtSignature(await sign(first, 'k1', 'RS256', { sub: 'b' }), keys)).toBe(
      true,
    );
    // The whole point of the cache: one fetch covered both.
    expect(calls).toBe(1);

    // The provider rotates. A kid the cache has never seen refetches rather than failing every
    // login until the TTL runs out.
    jwks = [await publicJwk(first, 'k1'), await publicJwk(second, 'k2')];
    expect(await verifyJwtSignature(await sign(second, 'k2', 'RS256', { sub: 'c' }), keys)).toBe(
      true,
    );
    expect(calls).toBe(2);
  });

  // `verifyJwtSignature` reads `header.kid` out of the attacker-supplied token BEFORE any
  // signature check, and `hooks.authenticate` funnels a bearer token through it — so this branch
  // is chosen by an unauthenticated caller. It used to refetch on every miss, which made one
  // forged token one outbound request to the IdP: the IdP blocks this app's egress and every real
  // login fails until the IdP unblocks it. The framework's own limiter cannot help — `auth` is
  // pipeline stage 6 and `rate-limit` is stage 7.
  test('500 sequential unknown-kid tokens issue at most one outbound fetch', async () => {
    const real = await rsaKeyPair();
    const attacker = await rsaKeyPair();
    const served = keySet([await publicJwk(real, 'k1')]);
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      fetch: served.fetch,
      clock,
    });

    // Warm the cache the ordinary way, so what is measured is the miss path alone.
    expect(await verifyJwtSignature(await sign(real, 'k1', 'RS256', { sub: 'ada' }), keys)).toBe(
      true,
    );
    const warm = served.calls;

    const forged = await sign(attacker, 'not-a-real-kid', 'RS256', { sub: 'the-vp' });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(await codeOf(() => verifyJwtSignature(forged, keys))).toBe('X_OAUTH_TOKEN_INVALID');
    }
    expect(served.calls - warm).toBeLessThanOrEqual(1);
  });

  test('a kid nothing in the set matches is a coded refusal, not a crash', async () => {
    const pair = await rsaKeyPair();
    const served = keySet([await publicJwk(pair, 'k1')]);
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      fetch: served.fetch,
      clock,
    });
    const token = await sign(pair, 'unknown-kid', 'RS256', { sub: 'ada' });
    expect(await codeOf(() => verifyJwtSignature(token, keys))).toBe('X_OAUTH_TOKEN_INVALID');
  });

  test('an unreachable key set is X_OAUTH_EXCHANGE_FAILED, with the curl that reproduces it', async () => {
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: async () => new Response('nope', { status: 503 }),
    });
    const thrown = await keys.keyFor('k1', 'RS256').catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AuthError);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.fix).toContain('curl -sS -m 5 https://op.test/jwks');
  });
});

describe('verifyIdToken through a key set', () => {
  const OP = registerOAuthProvider({
    id: 'jwks-test-op',
    authorizeUrl: 'https://op.test/authorize',
    tokenUrl: 'https://op.test/token',
    userInfoUrl: 'https://op.test/userinfo',
    userEmailsUrl: null,
    issuers: ['https://op.test'],
    jwksUri: 'https://op.test/jwks',
    scopes: ['openid', 'email'],
    usesPkce: true,
    usesNonce: true,
    clientIdEnv: 'JWKS_TEST_OP_CLIENT_ID',
    clientSecretEnv: 'JWKS_TEST_OP_CLIENT_SECRET',
  });

  const claims = {
    iss: 'https://op.test',
    aud: 'client-id',
    sub: 'the-vp',
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    nonce: 'stored-nonce',
    email: 'vp@corp.test',
    email_verified: true,
  };

  test('the takeover token — right iss, right aud, a VP sub, self-signed — is refused', async () => {
    const real = await rsaKeyPair();
    const attacker = await rsaKeyPair();
    const served = keySet([await publicJwk(real, 'k1')]);
    const keys = createJwksClient({
      provider: OP.id,
      jwksUri: OP.jwksUri ?? '',
      fetch: served.fetch,
      clock,
    });

    const forged = await sign(attacker, 'k1', 'RS256', claims);
    expect(
      await codeOf(() =>
        verifyIdToken({
          provider: OP.id,
          idToken: forged,
          clientId: 'client-id',
          nonce: 'stored-nonce',
          clock,
          keys,
        }),
      ),
    ).toBe('X_OAUTH_TOKEN_INVALID');

    // The same claims, signed by the issuer, are accepted — so the refusal above is the
    // signature and not one of the claim checks quietly doing the work.
    const genuine = await sign(real, 'k1', 'RS256', claims);
    const verified = await verifyIdToken({
      provider: OP.id,
      idToken: genuine,
      clientId: 'client-id',
      nonce: 'stored-nonce',
      clock,
      keys,
    });
    expect(verified.sub).toBe('the-vp');
  });

  test("keys: 'token-endpoint-tls' skips the check, and is the only way to", async () => {
    const attacker = await rsaKeyPair();
    const forged = await sign(attacker, 'k1', 'RS256', claims);
    // The exemption is real and still reachable — `exchangeOAuthCode` needs it — but a caller
    // has to name it, which is what stops a second door inheriting it by default.
    const verified = await verifyIdToken({
      provider: OP.id,
      idToken: forged,
      clientId: 'client-id',
      nonce: 'stored-nonce',
      clock,
      keys: 'token-endpoint-tls',
    });
    expect(verified.sub).toBe('the-vp');
  });
});

describe('a key set the process cannot reach at all', () => {
  // Distinct from a 503: `fetch` REJECTS on a DNS failure, a refused connection or the abort
  // signal firing, so there is no `response.ok` to read and the naked rejection would escape
  // every coded path in this package.
  test('a rejected fetch is X_OAUTH_EXCHANGE_FAILED carrying the runtime message', async () => {
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      fetch: async () => {
        throw new TypeError('Unable to connect. Is the computer able to access the url?');
      },
    });
    const thrown = await keys.keyFor('k1', 'RS256').catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.cause).toContain('Unable to connect');
    expect(error?.fix).toContain('curl -sS -m 5 https://op.test/jwks');
  });

  test('a rejection that is not an Error still gets a sentence, never [object Object]', async () => {
    const keys = createJwksClient({
      provider: 'test-op',
      jwksUri: 'https://op.test/jwks',
      clock,
      // Not an Error: `AbortSignal.timeout` rejects with a DOMException, and a runtime is free
      // to reject with anything at all — which is why `renderThrowable` renders the VALUE rather
      // than testing it with `instanceof`, whose own trap can throw.
      fetch: async () => {
        throw { name: 'AbortError' } as unknown as Error;
      },
    });
    const thrown = await keys.keyFor('k1', 'RS256').catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(error?.cause).toContain('AbortError');
    expect(error?.cause).not.toContain('[object Object]');
    expect(error?.cause).not.toContain('[object Object]');
  });
});

describe('a token with no kid', () => {
  test('resolves when the set holds exactly one key for that algorithm', async () => {
    const pair = await rsaKeyPair();
    const jwk = await publicJwk(pair, 'k1');
    delete jwk['kid'];
    const served = keySet([{ ...(await publicJwk(pair, 'k1')) }]);
    const keys = createJwksClient({
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
    const keys = createJwksClient({
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
    const keys = createJwksClient({
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
