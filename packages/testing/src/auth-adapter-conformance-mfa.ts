// The members a second factor and an account reclaim need from `UserStore`, for
// `authAdapterConformance`: every stored secret enumerated as stored, a compare-and-set on it, a
// recovery code consumed in ONE atomic step — two concurrent redemptions of one code must not both
// find it — and `updateUserWhere`, the compare-and-set `reclaimAccount` claims an account with.

import { expect } from 'bun:test';
import type { AuthAdapterCheck } from './auth-adapter-conformance-support';
import { own, seedUser } from './auth-adapter-conformance-support';

const REDEEMERS = 10;
/** A reclaim's claim: an instant before the epoch, which the row must store and match exactly. */
const CLAIM = new Date(-1_786_276_800_123);
const VERIFIED_AT = new Date('2026-08-09T12:00:02.000Z');

export const AUTH_ADAPTER_MFA_CHECKS: readonly AuthAdapterCheck[] = [
  {
    name: 'listUsersWithMfaSecret answers every enrolled user as stored, by id, and nobody else',
    async run({ adapter }) {
      const users = [await seedUser(adapter), await seedUser(adapter), await seedUser(adapter)];
      const [first, second, unenrolled] = users as [string, string, string];
      const enrolled = async () =>
        own(await adapter.listUsersWithMfaSecret(), users, (row) => row.userId);
      expect(await enrolled()).toEqual([]);
      await adapter.updateUser(first, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
      await adapter.updateUser(second, { mfaSecret: 'x1.not-really.sealed.value' });
      const expected = [
        { userId: first, mfaSecret: 'JBSWY3DPEHPK3PXP' },
        { userId: second, mfaSecret: 'x1.not-really.sealed.value' },
      ].sort((a, b) => (a.userId < b.userId ? -1 : 1));
      expect(await enrolled()).toEqual(expected);
      expect(expected.map((row) => row.userId)).not.toContain(unenrolled);
    },
  },
  {
    name: 'replaceMfaSecret writes only while the row still holds what was read',
    async run({ adapter }) {
      const [ada, grace] = [await seedUser(adapter), await seedUser(adapter)];
      await adapter.updateUser(ada, { mfaSecret: 'old' });
      expect(await adapter.replaceMfaSecret(ada, 'not-what-is-there', 'next')).toBe(false);
      expect(await adapter.replaceMfaSecret(grace, 'old', 'next')).toBe(false);
      expect((await adapter.findUserById(ada))?.mfaSecret).toBe('old');
      expect((await adapter.findUserById(grace))?.mfaSecret).toBeNull();
      expect(await adapter.replaceMfaSecret(ada, 'old', 'next')).toBe(true);
      expect(await adapter.replaceMfaSecret(ada, 'old', 'again')).toBe(false);
      expect((await adapter.findUserById(ada))?.mfaSecret).toBe('next');
    },
  },
  {
    // Optional on the seam: an adapter without it passes here, and `reclaimAccount` refuses it.
    name: 'updateUserWhere writes only while the row still holds what was expected',
    async run({ adapter }) {
      if (adapter.updateUserWhere === undefined) return;
      const [ada, grace] = [await seedUser(adapter), await seedUser(adapter)];
      const claimed = await adapter.updateUserWhere(
        ada,
        { emailVerifiedAt: null, disabledAt: null },
        { disabledAt: CLAIM, passwordHash: null },
      );
      expect(claimed?.disabledAt).toEqual(CLAIM);
      expect(
        await adapter.updateUserWhere(ada, { disabledAt: null }, { passwordHash: 'x' }),
      ).toBeNull();
      expect(
        await adapter.updateUserWhere(ada, { emailVerifiedAt: VERIFIED_AT }, { passwordHash: 'x' }),
      ).toBeNull();
      expect(
        await adapter.updateUserWhere(crypto.randomUUID(), {}, { passwordHash: 'x' }),
      ).toBeNull();
      expect((await adapter.findUserById(ada))?.passwordHash).toBeNull();
      expect((await adapter.findUserById(grace))?.disabledAt).toBeNull();
      const opened = await adapter.updateUserWhere(
        ada,
        { emailVerifiedAt: null, disabledAt: CLAIM },
        { emailVerifiedAt: VERIFIED_AT, disabledAt: null },
      );
      expect(opened?.disabledAt).toBeNull();
      expect(opened?.emailVerifiedAt).toEqual(VERIFIED_AT);
    },
  },
  {
    name: `${REDEEMERS} concurrent claims from one expectation: exactly one lands`,
    async run({ adapter }) {
      if (adapter.updateUserWhere === undefined) return;
      const write = adapter.updateUserWhere.bind(adapter);
      const ada = await seedUser(adapter);
      const answers = await Promise.all(
        Array.from({ length: REDEEMERS }, (_, n) =>
          write(ada, { disabledAt: null }, { disabledAt: new Date(CLAIM.getTime() - n) }),
        ),
      );
      const landed = answers.filter((answer) => answer !== null);
      expect(landed).toHaveLength(1);
      expect((await adapter.findUserById(ada))?.disabledAt).toEqual(landed[0]?.disabledAt ?? null);
    },
  },
  {
    name: 'consumeRecoveryCode removes exactly the hash it was given, once, from that user',
    async run({ adapter }) {
      const [ada, grace] = [await seedUser(adapter), await seedUser(adapter)];
      await adapter.updateUser(ada, { recoveryCodeHashes: ['h1', 'h2', 'h3'] });
      await adapter.updateUser(grace, { recoveryCodeHashes: ['h2'] });
      expect(await adapter.consumeRecoveryCode(ada, 'h2')).toBe(true);
      expect(await adapter.consumeRecoveryCode(ada, 'h2')).toBe(false);
      expect(await adapter.consumeRecoveryCode(ada, 'never-issued')).toBe(false);
      expect(await adapter.consumeRecoveryCode(crypto.randomUUID(), 'h1')).toBe(false);
      expect((await adapter.findUserById(ada))?.recoveryCodeHashes).toEqual(['h1', 'h3']);
      expect((await adapter.findUserById(grace))?.recoveryCodeHashes).toEqual(['h2']);
    },
  },
  {
    name: `${REDEEMERS} concurrent redemptions of one recovery code: exactly one is true`,
    async run({ adapter }) {
      const ada = await seedUser(adapter);
      await adapter.updateUser(ada, { recoveryCodeHashes: ['h1', 'h2'] });
      const answers = await Promise.all(
        Array.from({ length: REDEEMERS }, () => adapter.consumeRecoveryCode(ada, 'h1')),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
      expect((await adapter.findUserById(ada))?.recoveryCodeHashes).toEqual(['h2']);
    },
  },
];
