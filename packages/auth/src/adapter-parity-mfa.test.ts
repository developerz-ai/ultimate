// The two members a second factor needs from storage, on BOTH adapters: every stored secret
// enumerated as stored, and a recovery code consumed in one atomic step. The Postgres half runs
// on PGlite, as `adapter-parity-identity.test.ts` does — a real `array_remove`, a real row lock.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { openTotpSecret, saveTotpSecret, sealMfaSecrets } from './mfa-secret';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();

const ADA = '00000000-0000-7000-8000-000000000401';
const GRACE = '00000000-0000-7000-8000-000000000402';
const LINUS = '00000000-0000-7000-8000-000000000403';

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
    [LINUS, 'linus@corp.test'],
    [ADA, 'ada@corp.test'],
    [GRACE, 'grace@corp.test'],
  ] as const) {
    await adapter.createUser({
      id,
      email,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: new Date('2026-10-02T09:00:00.000Z'),
    });
  }
  return adapter;
};

const adapters: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', () => seeded(memoryAuthAdapter())],
  [
    'PostgresAuthAdapter',
    async () => {
      await client.execute(raw('delete from x_users'));
      return await seeded(postgresAuthAdapter(client));
    },
  ],
];

describe.each(adapters)('%s — the second factor at rest', (_, build) => {
  test('listUsersWithMfaSecret answers every enrolled user as stored, by id, and nobody else', async () => {
    const adapter = await build();
    expect(await adapter.listUsersWithMfaSecret()).toEqual([]);
    await adapter.updateUser(LINUS, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
    await adapter.updateUser(ADA, { mfaSecret: 'x1.not-really.sealed.value' });
    expect(await adapter.listUsersWithMfaSecret()).toEqual([
      { userId: ADA, mfaSecret: 'x1.not-really.sealed.value' },
      { userId: LINUS, mfaSecret: 'JBSWY3DPEHPK3PXP' },
    ]);
  });

  test('sealMfaSecrets seals the plaintext rows, leaves sealed ones byte-identical, and is idempotent', async () => {
    const adapter = await build();
    await adapter.updateUser(LINUS, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
    await adapter.updateUser(GRACE, { mfaSecret: 'GEZDGNBVGY3TQOJQ' });
    expect(await sealMfaSecrets({ adapter })).toEqual({ sealed: 2, alreadySealed: 0, skipped: 0 });

    const first = await adapter.listUsersWithMfaSecret();
    for (const row of first) expect(row.mfaSecret.startsWith('x1.')).toBe(true);
    expect(JSON.stringify(first)).not.toContain('JBSWY3DPEHPK3PXP');

    await adapter.updateUser(ADA, { mfaSecret: 'MFRGGZDFMZTWQ2LK' });
    expect(await sealMfaSecrets({ adapter })).toEqual({ sealed: 1, alreadySealed: 2, skipped: 0 });
    const second = await adapter.listUsersWithMfaSecret();
    // A second run rewrote nothing it had already sealed.
    expect(second.filter((row) => row.userId !== ADA)).toEqual([...first]);
    expect(await sealMfaSecrets({ adapter })).toEqual({ sealed: 0, alreadySealed: 3, skipped: 0 });
  });

  test('replaceMfaSecret writes only while the row still holds what was read', async () => {
    const adapter = await build();
    await adapter.updateUser(ADA, { mfaSecret: 'old' });
    expect(await adapter.replaceMfaSecret(ADA, 'not-what-is-there', 'next')).toBe(false);
    expect(await adapter.replaceMfaSecret(GRACE, 'old', 'next')).toBe(false);
    expect((await adapter.findUserById(ADA))?.mfaSecret).toBe('old');
    expect((await adapter.findUserById(GRACE))?.mfaSecret).toBeNull();
    expect(await adapter.replaceMfaSecret(ADA, 'old', 'next')).toBe(true);
    expect(await adapter.replaceMfaSecret(ADA, 'old', 'again')).toBe(false);
    expect((await adapter.findUserById(ADA))?.mfaSecret).toBe('next');
  });

  // The failure this pins: the run read a plaintext secret, the user re-enrolled, and the run
  // then wrote the OLD secret back, sealed — the new enrolment silently gone.
  test('a re-enrolment that lands mid-run survives, sealed, and the row is reported skipped', async () => {
    const adapter = await build();
    await adapter.updateUser(ADA, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
    await adapter.updateUser(GRACE, { mfaSecret: 'GEZDGNBVGY3TQOJQ' });
    const list = adapter.listUsersWithMfaSecret.bind(adapter);
    // Interleaved exactly where the race is: after the run has read, before it writes.
    adapter.listUsersWithMfaSecret = async () => {
      const read = await list();
      await saveTotpSecret({ adapter }, ADA, 'MFRGGZDFMZTWQ2LK');
      return read;
    };
    expect(await sealMfaSecrets({ adapter })).toEqual({ sealed: 1, alreadySealed: 0, skipped: 1 });

    const stored = (await adapter.findUserById(ADA))?.mfaSecret ?? '';
    expect(await openTotpSecret(stored)).toBe('MFRGGZDFMZTWQ2LK');
    adapter.listUsersWithMfaSecret = list;
    expect(await sealMfaSecrets({ adapter })).toEqual({ sealed: 0, alreadySealed: 2, skipped: 0 });
  });

  test('consumeRecoveryCode removes exactly the hash it was given, once', async () => {
    const adapter = await build();
    await adapter.updateUser(ADA, { recoveryCodeHashes: ['h1', 'h2', 'h3'] });
    await adapter.updateUser(GRACE, { recoveryCodeHashes: ['h2'] });

    expect(await adapter.consumeRecoveryCode(ADA, 'h2')).toBe(true);
    expect(await adapter.consumeRecoveryCode(ADA, 'h2')).toBe(false);
    expect(await adapter.consumeRecoveryCode(ADA, 'never-issued')).toBe(false);
    expect(await adapter.consumeRecoveryCode('00000000-0000-7000-8000-0000000004ff', 'h1')).toBe(
      false,
    );
    expect((await adapter.findUserById(ADA))?.recoveryCodeHashes).toEqual(['h1', 'h3']);
    // Another user's copy of the same hash is theirs, and untouched.
    expect((await adapter.findUserById(GRACE))?.recoveryCodeHashes).toEqual(['h2']);
  });

  test('ten concurrent redemptions of one code: exactly one answers true', async () => {
    const adapter = await build();
    await adapter.updateUser(ADA, { recoveryCodeHashes: ['h1', 'h2'] });
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => adapter.consumeRecoveryCode(ADA, 'h1')),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect((await adapter.findUserById(ADA))?.recoveryCodeHashes).toEqual(['h2']);
  });
});
