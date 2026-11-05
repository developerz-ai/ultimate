// `jwtBearerResolver()` — an external issuer's bearer in, `{ actor, scopes }` out, and ONE `null`
// for every way a token can be wrong, a key set that cannot be read included. The failures come
// first: each names the check that refused it in one log line, and no line carries the token.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EnvMissingError, frozenClock, setLogSink } from '@ultimat3/core';
import { jwksClient } from './jwks';
import { type JwtBearerResolverOptions, jwtBearerResolver } from './jwt-bearer-resolver';
import { actorFromService } from './policy-bridge';
import { base64Url } from './tokens';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const clock = frozenClock(NOW);
const ISSUER = 'https://login.example.test/tenant-a/v2.0';
const AUDIENCE = 'api://ledger';
const seconds = (offsetMs: number): number => Math.floor((NOW.getTime() + offsetMs) / 1000);
const text = (value: string): string => base64Url(new TextEncoder().encode(value));

const pair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

const sign = async (keys: CryptoKeyPair, claims: Readonly<Record<string, unknown>>) => {
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
  return jwksClient({
    provider: ISSUER,
    jwksUri: `${ISSUER}/keys`,
    clock,
    fetch: async () => new Response(JSON.stringify({ keys: [jwk] })),
  });
};

const CLAIMS = {
  iss: ISSUER,
  sub: 'agent-42',
  aud: AUDIENCE,
  exp: seconds(3_600_000),
  scp: ['ledger.read'],
  tid: 'tenant-a',
};

let lines: Record<string, unknown>[] = [];
let previous: ReturnType<typeof setLogSink> | undefined;
beforeEach(() => {
  lines = [];
  previous = setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
});
afterEach(() => {
  if (previous !== undefined) setLogSink(previous);
});

const options = async (
  issuer: CryptoKeyPair,
  over: Partial<JwtBearerResolverOptions> = {},
): Promise<JwtBearerResolverOptions> => {
  const keys = await jwksFor(issuer);
  return {
    keys: () => keys,
    issuers: [ISSUER],
    audience: AUDIENCE,
    clock,
    actorOf: (token) => actorFromService({ ...token.identity, orgId: String(token.raw['tid']) }),
    ...over,
  };
};

/**
 * The refusal's one log line: the check it names, and proof the token text is nowhere in ANY line
 * the refusal wrote (the key client logs its own outage beside it).
 */
const refusedBy = (token: string): unknown => {
  const refusals = lines.filter((line) => line['msg'] === 'auth.jwt_bearer.refused');
  expect(refusals).toHaveLength(1);
  const serialised = JSON.stringify(lines);
  for (const part of token.split('.')) if (part.length > 0) expect(serialised).not.toContain(part);
  expect(serialised).not.toContain('agent-42');
  return refusals[0]?.['check'];
};

describe('jwtBearerResolver refuses with null', () => {
  test('a token from an issuer this app does not accept', async () => {
    const issuer = await pair();
    const token = await sign(issuer, { ...CLAIMS, iss: 'https://elsewhere.test' });
    expect(await jwtBearerResolver(await options(issuer))(token)).toBeNull();
    expect(refusedBy(token)).toBe('issuer');
  });

  test('a token addressed to another audience', async () => {
    const issuer = await pair();
    const token = await sign(issuer, { ...CLAIMS, aud: 'api://other' });
    expect(await jwtBearerResolver(await options(issuer))(token)).toBeNull();
    expect(refusedBy(token)).toBe('audience');
  });

  test('an expired token', async () => {
    const issuer = await pair();
    const token = await sign(issuer, { ...CLAIMS, exp: seconds(-600_000) });
    expect(await jwtBearerResolver(await options(issuer))(token)).toBeNull();
    expect(refusedBy(token)).toBe('expiry');
  });

  test('an unsigned token, and one signed by whoever presented it', async () => {
    const issuer = await pair();
    const resolve = jwtBearerResolver(await options(issuer));
    const unsigned = `${text('{"alg":"none"}')}.${text(JSON.stringify(CLAIMS))}.`;
    expect(await resolve(unsigned)).toBeNull();
    expect(refusedBy(unsigned)).toBe('signature');
    lines = [];
    const forged = await sign(await pair(), CLAIMS);
    expect(await resolve(forged)).toBeNull();
    expect(refusedBy(forged)).toBe('signature');
  });

  test('a token the app own accept() turns down', async () => {
    const issuer = await pair();
    const token = await sign(issuer, CLAIMS);
    const resolve = jwtBearerResolver(
      await options(issuer, { accept: (raw) => raw['tid'] === 'tenant-b' }),
    );
    expect(await resolve(token)).toBeNull();
    expect(refusedBy(token)).toBe('accept');
  });

  test('a token without the required scope', async () => {
    const issuer = await pair();
    const token = await sign(issuer, CLAIMS);
    const resolve = jwtBearerResolver(await options(issuer, { requiredScope: 'ledger.write' }));
    expect(await resolve(token)).toBeNull();
    expect(refusedBy(token)).toBe('scope');
  });

  test('a key source that throws — fail closed, like an unknown kid', async () => {
    const issuer = await pair();
    const token = await sign(issuer, CLAIMS);
    const thunkThrows = jwtBearerResolver(
      await options(issuer, {
        keys: () => {
          // What a discovery thunk throws when the issuer is not configured.
          throw new EnvMissingError({ cause: 'IDP_ISSUER is not set', fix: 'x env check' });
        },
      }),
    );
    expect(await thunkThrows(token)).toBeNull();
    expect(refusedBy(token)).toBe('key-set');
    lines = [];
    const fetchFails = jwtBearerResolver(
      await options(issuer, {
        keys: () =>
          jwksClient({
            provider: ISSUER,
            jwksUri: `${ISSUER}/keys`,
            clock,
            fetch: async () => new Response('down', { status: 503 }),
          }),
      }),
    );
    expect(await fetchFails(token)).toBeNull();
    expect(refusedBy(token)).toBe('key-set');
  });
});

describe('jwtBearerResolver accepts', () => {
  test('the right token is the actor actorOf builds, with the token scopes', async () => {
    const issuer = await pair();
    let reads = 0;
    const keys = await jwksFor(issuer);
    const resolve = jwtBearerResolver(
      await options(issuer, {
        keys: () => {
          reads += 1;
          return keys;
        },
        accept: (raw) => raw['tid'] === 'tenant-a',
        requiredScope: 'ledger.read',
      }),
    );
    // The thunk is read when a token arrives, never when the resolver is declared.
    expect(reads).toBe(0);
    const caller = await resolve(await sign(issuer, CLAIMS));
    expect(reads).toBe(1);
    expect(caller?.actor.kind).toBe('service');
    expect(caller?.actor.id).toBe('agent-42');
    expect(caller?.actor.orgId).toBe('tenant-a');
    expect([...(caller?.scopes ?? [])]).toEqual(['ledger.read']);
    expect(lines).toEqual([]);
  });
});
