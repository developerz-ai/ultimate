// A 200 that carries no usable key is a failed fetch, not a new key set. Adopting it replaced a
// working cache with an empty one stamped fresh, so every verification failed until the TTL ran
// out — on one bad answer from the issuer, or one forged `kid` that spent the early refresh.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { createJwksClient } from './jwks';

const clock = frozenClock(new Date('2026-08-16T12:00:00.000Z'));

const publicJwk = async (kid: string): Promise<Record<string, unknown>> => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
};

/** Answers the scripted bodies in order, then repeats the last one. */
const scripted = (bodies: readonly string[]) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async (): Promise<Response> => {
      const body = bodies[Math.min(calls, bodies.length - 1)] ?? '';
      calls += 1;
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  };
};

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

const UNUSABLE: readonly (readonly [string, string])[] = [
  ['an empty keys array', JSON.stringify({ keys: [] })],
  ['an object with no keys member', JSON.stringify({ error: 'temporarily_unavailable' })],
  ['a body that is not JSON', '<html>maintenance</html>'],
  [
    'entries none of which can be imported',
    JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', kid: 'broken', alg: 'ES256', x: '!' }, 7] }),
  ],
];

describe('a key set with no importable key', () => {
  test.each(UNUSABLE)('%s keeps the keys already cached', async (_name, unusable) => {
    const good = JSON.stringify({ keys: [await publicJwk('live')] });
    const source = scripted([good, unusable]);
    const client = createJwksClient({
      provider: 'google',
      jwksUri: 'https://issuer.example/jwks',
      fetch: source.fetch,
      clock,
    });
    expect(await client.keyFor('live', 'ES256')).toBeDefined();
    expect(source.calls).toBe(1);

    // An unknown kid spends the one early refresh, and the issuer answers with nothing usable.
    expect(await codeOf(client.keyFor('forged', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(source.calls).toBe(2);

    // The working key is still served, from cache, with no further request.
    expect(await client.keyFor('live', 'ES256')).toBeDefined();
    expect(source.calls).toBe(2);
  });

  test('a cold client reports the failed fetch, and the next call asks again', async () => {
    const source = scripted([
      JSON.stringify({ keys: [] }),
      JSON.stringify({ keys: [await publicJwk('live')] }),
    ]);
    const client = createJwksClient({
      provider: 'google',
      jwksUri: 'https://issuer.example/jwks',
      fetch: source.fetch,
      clock,
    });
    const thrown = await client.keyFor('live', 'ES256').catch((error: unknown) => error);
    expect(thrown instanceof AuthError ? thrown.code : thrown).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(thrown instanceof AuthError ? thrown.fix : '').toBe(
      'curl -sS -m 5 https://issuer.example/jwks',
    );
    // Not stamped fresh: the empty answer did not buy the issuer a TTL of silence.
    expect(await client.keyFor('live', 'ES256')).toBeDefined();
    expect(source.calls).toBe(2);
  });
});
