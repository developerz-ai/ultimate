// `PasskeyStore` on both adapters, one suite: the Postgres half on PGlite over `AUTH_TABLES`, so the
// constraints are the real ones. Single-use takes, ceremony scoping, the counter compare-and-set,
// a duplicate credential id, owner-scoped deletes, the expiry sweep — and a whole sign-in on SQL.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter, PasskeyChallengeRecord, PasskeyCredential } from './adapter';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { passkeyLogin } from './passkey-login';
import { passkeyStepUp } from './passkey-step-up';
import { softAuthenticator } from './soft-authenticator';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const clock = frozenClock(NOW.getTime());
const client = pgliteClient();
const ADA = '00000000-0000-7000-8000-000000000b01';
const GRACE = '00000000-0000-7000-8000-000000000b02';

beforeAll(async () => {
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

const ADAPTERS: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', async () => memoryAuthAdapter(clock)],
  [
    'PostgresAuthAdapter on PGlite',
    async () => {
      for (const table of [
        'x_passkey_evidence',
        'x_passkey_challenges',
        'x_passkeys',
        'x_sessions',
        'x_users',
      ]) {
        await client.execute(raw(`delete from ${table}`));
      }
      return postgresAuthAdapter(client, clock);
    },
  ],
];

const seeded = async (make: () => Promise<AuthAdapter>): Promise<AuthAdapter> => {
  const adapter = await make();
  for (const [id, email] of [
    [ADA, 'ada@example.com'],
    [GRACE, 'grace@example.com'],
  ] as const) {
    await adapter.createUser({
      id,
      email,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
  }
  return adapter;
};

const credential = (id: string, userId = ADA, signCount = 0): PasskeyCredential => ({
  id,
  userId,
  publicKey: 'pQECAyYgASFYIA',
  algorithm: -7,
  signCount,
  transports: ['internal'],
  createdAt: NOW,
  lastUsedAt: null,
});

const challenge = (id: string, expiresInMs = 60_000, createdAt = NOW): PasskeyChallengeRecord => ({
  id,
  ceremony: 'login',
  userId: null,
  digest: null,
  nonce: null,
  expiresAt: new Date(createdAt.getTime() + expiresInMs),
  createdAt,
});

describe.each(ADAPTERS)('%s · PasskeyStore', (_name, make) => {
  test('a credential round-trips, lists oldest first, and a second one at one id is refused', async () => {
    const adapter = await seeded(make);
    await adapter.putPasskey(credential('cred-B'));
    await adapter.putPasskey({ ...credential('cred-a'), createdAt: new Date(NOW.getTime() + 1) });
    expect((await adapter.listPasskeys(ADA)).map((row) => row.id)).toEqual(['cred-B', 'cred-a']);
    expect(await adapter.findPasskey('cred-B')).toEqual(credential('cred-B'));
    const error = await caught(() => adapter.putPasskey(credential('cred-B', GRACE)));
    expect(`${error?.code} ${String(error?.meta?.['table'])}`).toBe(
      'X_AUTH_WRITE_FAILED x_passkeys',
    );
  });

  test('the counter advances only from the value it was read at', async () => {
    const adapter = await seeded(make);
    await adapter.putPasskey(credential('cred-1', ADA, 4));
    expect(await adapter.advancePasskeyCounter('cred-1', 4, 5, NOW)).toBe(true);
    expect(await adapter.advancePasskeyCounter('cred-1', 4, 6, NOW)).toBe(false);
    const row = await adapter.findPasskey('cred-1');
    expect([row?.signCount, row?.lastUsedAt?.toISOString()]).toEqual([5, NOW.toISOString()]);
  });

  test('a passkey is deleted only by its owner', async () => {
    const adapter = await seeded(make);
    await adapter.putPasskey(credential('cred-1'));
    expect(await adapter.deletePasskey(GRACE, 'cred-1')).toBe(false);
    expect(await adapter.deletePasskey(ADA, 'cred-1')).toBe(true);
    expect(await adapter.findPasskey('cred-1')).toBeNull();
  });

  test('a challenge is taken once, and only for its own ceremony', async () => {
    const adapter = await seeded(make);
    await adapter.putPasskeyChallenge(challenge('c1'));
    expect(await adapter.takePasskeyChallenge('c1', 'step-up')).toBeNull();
    expect((await adapter.takePasskeyChallenge('c1', 'login'))?.id).toBe('c1');
    expect(await adapter.takePasskeyChallenge('c1', 'login')).toBeNull();
  });

  test('issuing a challenge sweeps the ones already expired, and keeps the live ones', async () => {
    const adapter = await seeded(make);
    await adapter.putPasskeyChallenge(challenge('stale', 1_000));
    await adapter.putPasskeyChallenge(challenge('live', 600_000));
    await adapter.putPasskeyChallenge(challenge('new', 60_000, new Date(NOW.getTime() + 5_000)));
    expect(await adapter.takePasskeyChallenge('stale', 'login')).toBeNull();
    expect((await adapter.takePasskeyChallenge('live', 'login'))?.id).toBe('live');
  });

  test('a whole sign-in and a step-up run on this adapter', async () => {
    const adapter = await seeded(make);
    const auth = defineAuth({
      adapter,
      clock,
      passkeys: { rpId: 'localhost', origins: ['http://localhost:3000'] },
    });
    const passkeys = passkeyLogin(auth);
    const device = await softAuthenticator({ origin: 'http://localhost:3000' });
    await passkeys.register({
      userId: ADA,
      response: await device.create(await passkeys.registerOptions({ userId: ADA })),
    });
    const result = await passkeys.login({
      response: await device.get(await passkeys.loginOptions()),
    });
    expect(result.actor.id).toBe(ADA);
    const stepUp = passkeyStepUp<string>(auth, { digest: ({ input }) => input });
    const options = await stepUp.options({ userId: ADA, input: 'erase:grace' });
    const evidence = await stepUp.verify({
      userId: ADA,
      input: 'erase:grace',
      response: await device.get(options),
    });
    expect(await adapter.listPasskeyEvidence(evidence.digest)).toEqual([evidence]);
    expect((await adapter.findPasskey(device.credentialId))?.signCount).toBe(2);
  });
});
