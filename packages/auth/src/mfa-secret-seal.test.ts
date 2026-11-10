// `sealMfaSecrets`, the one-shot that seals second-factor secrets written in the clear: it seals
// what it finds, rewrites nothing it already sealed, and never puts an old secret back over a
// re-enrolment. The store members it writes through are `@ultimat3/testing`'s
// `authAdapterConformance`; this is the run above them.

import { describe, expect, test } from 'bun:test';
import type { AuthAdapter } from './adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { openTotpSecret, saveTotpSecret, sealMfaSecrets } from './mfa-secret';

const ADA = '00000000-0000-7000-8000-000000000401';
const GRACE = '00000000-0000-7000-8000-000000000402';
const LINUS = '00000000-0000-7000-8000-000000000403';

const seeded = async (): Promise<AuthAdapter> => {
  const adapter = memoryAuthAdapter();
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

describe('sealMfaSecrets', () => {
  test('seals the plaintext rows, leaves sealed ones byte-identical, and is idempotent', async () => {
    const adapter = await seeded();
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

  // The failure this pins: the run read a plaintext secret, the user re-enrolled, and the run
  // then wrote the OLD secret back, sealed — the new enrolment silently gone.
  test('a re-enrolment that lands mid-run survives, sealed, and the row is reported skipped', async () => {
    const adapter = await seeded();
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
});
