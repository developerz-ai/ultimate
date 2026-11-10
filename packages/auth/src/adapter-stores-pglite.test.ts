// The second-factor and passkey members of both adapters at the unit tier: memory, and the
// Postgres adapter on PGlite (real constraints, a real `array_remove`). The contract an adapter
// owes is `@ultimat3/testing`'s `authAdapterConformance`; these are the members `@ultimat3/auth`'s
// own flows lean on, run here because a package cannot borrow coverage from the one above it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter, PasskeyCredential } from './adapter';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { countUnsealedMfaSecrets, saveTotpSecret } from './mfa-secret';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const clock = frozenClock(NOW.getTime());
const client = pgliteClient();
const ADA = '00000000-0000-7000-8000-000000000c01';
const GRACE = '00000000-0000-7000-8000-000000000c02';

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

const seeded = async (adapter: AuthAdapter): Promise<AuthAdapter> => {
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

const ADAPTERS: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', () => seeded(memoryAuthAdapter(clock))],
  [
    'PostgresAuthAdapter on PGlite',
    async () => {
      for (const table of ['x_passkey_evidence', 'x_passkeys', 'x_users']) {
        await client.execute(raw(`delete from ${table}`));
      }
      return seeded(postgresAuthAdapter(client, clock));
    },
  ],
];

const credential = (id: string, createdAt = NOW): PasskeyCredential => ({
  id,
  userId: ADA,
  publicKey: 'pQECAyYgASFYIA',
  algorithm: -7,
  signCount: 3,
  transports: ['internal', 'hybrid'],
  createdAt,
  lastUsedAt: null,
});

describe.each(ADAPTERS)('%s', (_name, make) => {
  test('the second factor: enumerate, compare-and-set, count unsealed, consume once', async () => {
    const adapter = await make();
    await adapter.updateUser(GRACE, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
    await saveTotpSecret({ adapter }, ADA, 'GEZDGNBVGY3TQOJQ');
    expect((await adapter.listUsersWithMfaSecret()).map((row) => row.userId)).toEqual([ADA, GRACE]);
    expect(await countUnsealedMfaSecrets({ adapter })).toBe(1);
    expect(await adapter.replaceMfaSecret(GRACE, 'stale', 'next')).toBe(false);
    expect(await adapter.replaceMfaSecret(GRACE, 'JBSWY3DPEHPK3PXP', 'next')).toBe(true);
    await adapter.updateUser(ADA, { recoveryCodeHashes: ['h1', 'h2'] });
    expect(await adapter.consumeRecoveryCode(ADA, 'h1')).toBe(true);
    expect(await adapter.consumeRecoveryCode(ADA, 'h1')).toBe(false);
    expect((await adapter.findUserById(ADA))?.recoveryCodeHashes).toEqual(['h2']);
  });

  test('passkeys: one id tie broken by id, a counter moved once, a delete by the owner', async () => {
    const adapter = await make();
    await adapter.putPasskey(credential('cred-b'));
    await adapter.putPasskey(credential('cred-a'));
    expect((await adapter.listPasskeys(ADA)).map((row) => row.id)).toEqual(['cred-a', 'cred-b']);
    expect((await adapter.findPasskey('cred-a'))?.transports).toEqual(['internal', 'hybrid']);
    expect(await adapter.findPasskey('nobody')).toBeNull();
    expect(await adapter.advancePasskeyCounter('cred-a', 3, 4, NOW)).toBe(true);
    expect(await adapter.advancePasskeyCounter('cred-a', 3, 5, NOW)).toBe(false);
    expect(await adapter.advancePasskeyCounter('nobody', 0, 1, NOW)).toBe(false);
    expect((await adapter.findPasskey('cred-a'))?.lastUsedAt?.getTime()).toBe(NOW.getTime());
    expect(await adapter.deletePasskey(GRACE, 'cred-a')).toBe(false);
    expect(await adapter.deletePasskey(ADA, 'cred-a')).toBe(true);
    expect(await adapter.deletePasskey(ADA, 'cred-a')).toBe(false);
  });

  test('passkey evidence lists by digest, oldest first, and one id is stored once', async () => {
    const adapter = await make();
    const evidence = {
      id: 'ev-1',
      userId: ADA,
      credentialId: 'cred-a',
      digest: 'digest-1',
      nonce: 'bm9uY2U',
      authenticatorData: 'YXV0aA',
      clientDataJSON: 'Y2xpZW50',
      signature: 'c2ln',
      publicKey: 'pQECAyYgASFYIA',
      algorithm: -7,
      createdAt: new Date(NOW.getTime() + 1),
    };
    await adapter.putPasskeyEvidence(evidence);
    await adapter.putPasskeyEvidence({ ...evidence, id: 'ev-0', createdAt: NOW });
    expect((await adapter.listPasskeyEvidence('digest-1')).map((row) => row.id)).toEqual([
      'ev-0',
      'ev-1',
    ]);
    await expect(adapter.putPasskeyEvidence(evidence)).rejects.toThrow();
    expect(await adapter.listPasskeyEvidence('other')).toEqual([]);
  });
});
