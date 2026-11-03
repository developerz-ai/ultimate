// The key set is unreachable. An IdP outage must not end every login while the key that verifies
// them sits in memory, and it must not cost one outbound request per token either.

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, logger } from '@ultimat3/core';
import { AuthError } from './errors';
import {
  DEFAULT_JWKS_TTL_MS,
  JWKS_FAILURE_COOLDOWN_MS,
  JWKS_STALE_IF_ERROR_MS,
  jwksClient,
} from './jwks';

const publicJwk = async (kid: string): Promise<Record<string, unknown>> => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
};

interface Rig {
  readonly clock: ReturnType<typeof frozenClock>;
  readonly client: ReturnType<typeof jwksClient>;
  readonly issuer: { down: boolean; calls: number; keys: readonly Record<string, unknown>[] };
}

const rig = async (): Promise<Rig> => {
  const clock = frozenClock(new Date('2026-08-16T12:00:00.000Z'));
  const issuer = {
    down: false,
    calls: 0,
    keys: [await publicJwk('live')] as readonly Record<string, unknown>[],
  };
  const client = jwksClient({
    provider: 'google',
    jwksUri: 'https://issuer.example/jwks',
    clock,
    fetch: async () => {
      issuer.calls += 1;
      return issuer.down
        ? new Response('unavailable', { status: 503 })
        : Response.json({ keys: issuer.keys });
    },
  });
  await client.keyFor('live', 'ES256');
  issuer.calls = 0;
  return { clock, client, issuer };
};

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
  }
  return 'did-not-throw';
};

const warned = spyOn(logger, 'warn');

const staleServed = () => {
  warned.mockClear();
  return {
    count: () =>
      warned.mock.calls.filter(([message]) => message === 'auth.jwks.stale_served').length,
  };
};

afterAll(() => {
  warned.mockRestore();
});

describe('a known key through an IdP outage', () => {
  test('five logins answer from cache at the cost of one fetch, and say so', async () => {
    const { clock, client, issuer } = await rig();
    const log = staleServed();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);

    for (let call = 0; call < 5; call += 1) {
      expect(await client.keyFor('live', 'ES256')).toBeDefined();
    }

    expect(issuer.calls).toBe(1);
    expect(log.count()).toBe(1);
  });

  test('a forged kid inside the cooldown is refused and costs no fetch', async () => {
    const { clock, client, issuer } = await rig();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);
    await client.keyFor('live', 'ES256');
    expect(issuer.calls).toBe(1);

    for (let call = 0; call < 3; call += 1) {
      expect(await codeOf(client.keyFor(`forged-${call}`, 'ES256'))).toBe(
        'X_OAUTH_EXCHANGE_FAILED',
      );
    }

    expect(issuer.calls).toBe(1);
  });

  test('the cooldown spends one more fetch once it is over', async () => {
    const { clock, client, issuer } = await rig();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);
    await client.keyFor('live', 'ES256');

    clock.advance(JWKS_FAILURE_COOLDOWN_MS - 1);
    await client.keyFor('live', 'ES256');
    expect(issuer.calls).toBe(1);

    clock.advance(1);
    await client.keyFor('live', 'ES256');
    expect(issuer.calls).toBe(2);
  });

  test('past the hour the known key is refused too', async () => {
    const { clock, client, issuer } = await rig();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + JWKS_STALE_IF_ERROR_MS - 1);
    expect(await client.keyFor('live', 'ES256')).toBeDefined();

    clock.advance(JWKS_FAILURE_COOLDOWN_MS);
    expect(await codeOf(client.keyFor('live', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    // And inside the cooldown that refusal, the same answer with no request behind it.
    const calls = issuer.calls;
    expect(await codeOf(client.keyFor('live', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(issuer.calls).toBe(calls);
  });

  test('recovery after the cooldown adopts the new set, and a rotated kid verifies', async () => {
    const { clock, client, issuer } = await rig();
    const log = staleServed();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);
    await client.keyFor('live', 'ES256');
    expect(log.count()).toBe(1);

    issuer.down = false;
    issuer.keys = [await publicJwk('rotated')];
    clock.advance(JWKS_FAILURE_COOLDOWN_MS);

    expect(await client.keyFor('rotated', 'ES256')).toBeDefined();
    expect(issuer.calls).toBe(2);
    expect(log.count()).toBe(1);
  });

  test('a failed early refresh arms the cooldown for the ordinary one', async () => {
    const { clock, client, issuer } = await rig();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS - 1);
    expect(await codeOf(client.keyFor('forged', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(issuer.calls).toBe(1);

    // The TTL has now passed, but the issuer failed one millisecond ago.
    clock.advance(1);
    expect(await client.keyFor('live', 'ES256')).toBeDefined();
    expect(issuer.calls).toBe(1);
  });

  test('five logins at once on one failed fetch log one line', async () => {
    const { clock, client, issuer } = await rig();
    const log = staleServed();
    issuer.down = true;
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);

    await Promise.all(Array.from({ length: 5 }, () => client.keyFor('live', 'ES256')));

    expect(issuer.calls).toBe(1);
    expect(log.count()).toBe(1);
  });

  test('a rotated kid met during a blip verifies right after the cooldown, not a TTL later', async () => {
    const { clock, client, issuer } = await rig();
    issuer.down = true;
    expect(await codeOf(client.keyFor('rotated', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(issuer.calls).toBe(1);

    issuer.down = false;
    issuer.keys = [await publicJwk('rotated')];
    clock.advance(JWKS_FAILURE_COOLDOWN_MS + 1_000);

    expect(await client.keyFor('rotated', 'ES256')).toBeDefined();
    expect(issuer.calls).toBe(2);
  });

  test('a successful miss still spends the gate: a forged kid costs one fetch per TTL', async () => {
    const { client, issuer } = await rig();
    expect(await codeOf(client.keyFor('forged-1', 'ES256'))).toBe('X_OAUTH_TOKEN_INVALID');
    expect(await codeOf(client.keyFor('forged-2', 'ES256'))).toBe('X_OAUTH_TOKEN_INVALID');
    expect(issuer.calls).toBe(1);
  });

  test('a healthy key set serves no stale answer and logs nothing', async () => {
    const { clock, client, issuer } = await rig();
    const log = staleServed();
    clock.advance(DEFAULT_JWKS_TTL_MS + 1);
    await client.keyFor('live', 'ES256');
    expect(issuer.calls).toBe(1);
    expect(log.count()).toBe(0);
  });

  test('a cold client has nothing to serve: the refusal, then the cooldown', async () => {
    const clock = frozenClock(new Date('2026-08-16T12:00:00.000Z'));
    let calls = 0;
    const client = jwksClient({
      provider: 'google',
      jwksUri: 'https://issuer.example/jwks',
      clock,
      fetch: async () => {
        calls += 1;
        return new Response('unavailable', { status: 503 });
      },
    });
    expect(await codeOf(client.keyFor('live', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(await codeOf(client.keyFor('live', 'ES256'))).toBe('X_OAUTH_EXCHANGE_FAILED');
    expect(calls).toBe(1);
  });

  test('the two numbers are the ones this client promises', () => {
    expect(JWKS_STALE_IF_ERROR_MS).toBe(60 * 60 * 1000);
    expect(JWKS_FAILURE_COOLDOWN_MS).toBe(30 * 1000);
  });
});
