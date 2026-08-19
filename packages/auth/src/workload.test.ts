// The failure case first: a token this service did not ask for, addressed to somebody else, or
// signed by whoever presented it, must not resolve to a service actor. Before `workload.ts` the
// only credential two Ultimate services could share was a long-lived secret in an env var, with
// no rotation flow and no per-caller identity — which is what a security review rejects.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { createJwksClient } from './jwks';
import { actorFromService } from './policy-bridge';
import { base64Url } from './tokens';
import { verifyWorkloadToken } from './workload';

const NOW = new Date('2026-08-16T12:00:00.000Z');
const clock = frozenClock(NOW);
const seconds = (offsetMs: number): number => Math.floor((NOW.getTime() + offsetMs) / 1000);
const text = (value: string): string => base64Url(new TextEncoder().encode(value));

const pair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

const sign = async (
  keys: CryptoKeyPair,
  claims: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const body = `${text('{"alg":"ES256","kid":"k1"}')}.${text(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

const jwksFor = async (keys: CryptoKeyPair) => {
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
  return createJwksClient({
    provider: 'https://kubernetes.default.svc',
    jwksUri: 'https://kubernetes.default.svc/openid/v1/jwks',
    clock,
    fetch: async () => new Response(JSON.stringify({ keys: [jwk] })),
  });
};

const CLAIMS = {
  iss: 'https://kubernetes.default.svc',
  sub: 'system:serviceaccount:payments:worker',
  aud: ['https://ledger.internal'],
  exp: seconds(3_600_000),
  scope: 'ledger:post ledger:read',
};

const base = async () => ({
  keys: await jwksFor(await pair()),
  issuers: ['https://kubernetes.default.svc'],
  audience: 'https://ledger.internal',
  clock,
});

const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

describe('verifyWorkloadToken', () => {
  test('a token the caller signed themselves is refused', async () => {
    const issuer = await pair();
    const attacker = await pair();
    const input = { ...(await base()), keys: await jwksFor(issuer) };
    const forged = await sign(attacker, CLAIMS);
    expect(await codeOf(() => verifyWorkloadToken({ ...input, token: forged }))).toBe(
      'X_UNAUTHENTICATED',
    );
  });

  test('a projected service-account token resolves to a service actor with its own scopes', async () => {
    const issuer = await pair();
    const verified = await verifyWorkloadToken({
      ...(await base()),
      keys: await jwksFor(issuer),
      token: await sign(issuer, CLAIMS),
    });
    expect(verified.claims.sub).toBe('system:serviceaccount:payments:worker');
    expect(verified.identity.scopes).toEqual(['ledger:post', 'ledger:read']);

    const actor = actorFromService(verified.identity);
    expect(actor.kind).toBe('service');
    // The caller's own name reaches the actor, so a trace names the workload rather than "service".
    expect(actor.id).toBe('system:serviceaccount:payments:worker');
    expect(actor.scopes).toEqual(['ledger:post', 'ledger:read']);
  });

  test('an issuer this service does not accept, and an audience it is not, are both refused', async () => {
    const issuer = await pair();
    const keys = await jwksFor(issuer);
    const input = { ...(await base()), keys };
    expect(
      await codeOf(async () =>
        verifyWorkloadToken({
          ...input,
          token: await sign(issuer, { ...CLAIMS, iss: 'https://elsewhere.test' }),
        }),
      ),
    ).toBe('X_UNAUTHENTICATED');
    expect(
      await codeOf(async () =>
        verifyWorkloadToken({
          ...input,
          token: await sign(issuer, { ...CLAIMS, aud: ['https://another.internal'] }),
        }),
      ),
    ).toBe('X_UNAUTHENTICATED');
  });

  test('expiry and not-before are both enforced, against the injected clock', async () => {
    const issuer = await pair();
    const input = { ...(await base()), keys: await jwksFor(issuer) };
    expect(
      await codeOf(async () =>
        verifyWorkloadToken({
          ...input,
          token: await sign(issuer, { ...CLAIMS, exp: seconds(-120_000) }),
        }),
      ),
    ).toBe('X_UNAUTHENTICATED');
    expect(
      await codeOf(async () =>
        verifyWorkloadToken({
          ...input,
          token: await sign(issuer, { ...CLAIMS, nbf: seconds(3_600_000) }),
        }),
      ),
    ).toBe('X_UNAUTHENTICATED');
  });

  test('a token with no scope claim carries none, rather than inheriting any', async () => {
    const issuer = await pair();
    const claims = { ...CLAIMS };
    delete (claims as Record<string, unknown>)['scope'];
    const verified = await verifyWorkloadToken({
      ...(await base()),
      keys: await jwksFor(issuer),
      token: await sign(issuer, claims),
    });
    expect(verified.identity.scopes).toEqual([]);
    expect(actorFromService(verified.identity).scopes).toEqual([]);
  });
});

describe('a token whose payload is not a set of claims', () => {
  const causeOf = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
    } catch (error) {
      return error instanceof AuthError ? error.cause : `not-an-AuthError: ${String(error)}`;
    }
    return 'did-not-throw';
  };

  /** Verifies a token that is already signed by the key set, so only the payload is under test. */
  const causeFor = async (token: string): Promise<string> => {
    const keys = await pair();
    return await causeOf(async () =>
      verifyWorkloadToken({
        token,
        keys: await jwksFor(keys),
        issuers: ['https://kubernetes.default.svc'],
        audience: 'https://ledger.internal',
        clock,
      }),
    );
  };

  test('a payload that is not JSON describing an object is refused after the signature', async () => {
    const keys = await pair();
    // Correctly signed, so this is the payload check refusing and not the signature check.
    const body = `${text('{"alg":"ES256","kid":"k1"}')}.${text('["not","an","object"]')}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      new TextEncoder().encode(body),
    );
    const token = `${body}.${base64Url(new Uint8Array(signature))}`;

    const cause = await causeOf(async () =>
      verifyWorkloadToken({
        token,
        keys: await jwksFor(keys),
        issuers: ['https://kubernetes.default.svc'],
        audience: 'https://ledger.internal',
        clock,
      }),
    );
    expect(cause).toContain('the payload is not base64url-encoded JSON describing an object');
  });

  test.each<[string, Readonly<Record<string, unknown>>]>([
    ['no sub at all', { iss: CLAIMS.iss, aud: CLAIMS.aud, exp: CLAIMS.exp }],
    ['an empty sub', { ...CLAIMS, sub: '' }],
    ['no iss at all', { sub: CLAIMS.sub, aud: CLAIMS.aud, exp: CLAIMS.exp }],
    ['a non-string sub', { ...CLAIMS, sub: 42 }],
  ])('%s carries no identity, so no actor is minted', async (_name, claims) => {
    const keys = await pair();
    const cause = await causeOf(async () =>
      verifyWorkloadToken({
        token: await sign(keys, claims),
        keys: await jwksFor(keys),
        issuers: ['https://kubernetes.default.svc'],
        audience: 'https://ledger.internal',
        clock,
      }),
    );
    expect(cause).toContain('the payload carries no iss or sub');
  });

  test('a token with no numeric exp is refused rather than read as never expiring', async () => {
    const { exp: _exp, ...withoutExp } = CLAIMS;
    const keys = await pair();
    const cause = await causeOf(async () =>
      verifyWorkloadToken({
        token: await sign(keys, withoutExp),
        keys: await jwksFor(keys),
        issuers: ['https://kubernetes.default.svc'],
        audience: 'https://ledger.internal',
        clock,
      }),
    );
    expect(cause).toContain('the payload carries no numeric exp');
    expect(await causeFor('not.a.jwt')).not.toBe('did-not-throw');
  });
});
