// The failure case first: the projection must never carry a secret. A quarterly access review is
// a list somebody pastes into a ticket, and `AuthUser` holds a password hash, a TOTP secret and a
// set of recovery-code hashes — so an allow-list is the only shape of this function that stays
// correct after the next column is added to the row.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthAdapter, AuthUser } from './adapter';
import { type Auth, defineAuth } from './auth';
import { describeUser, findUserByExternalId, listOrgUsers } from './directory';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';

const START = 1_700_000_000_000;

const seed = async (): Promise<{ auth: Auth; adapter: MemoryAdapter }> => {
  const adapter = new MemoryAdapter();
  const auth = defineAuth({ adapter, clock: frozenClock(START) });
  const rows: readonly [string, string, string | null, readonly string[]][] = [
    ['zoe', 'zoe@corp.test', 'org-1', ['admin']],
    ['alice', 'alice@corp.test', 'org-1', ['member']],
    ['carol', 'carol@corp.test', 'org-2', ['admin']],
  ];
  for (const [id, email, orgId, roles] of rows) {
    await adapter.createUser({
      id,
      email,
      passwordHash: 'argon2-hash',
      orgId,
      roles,
      externalId: `okta|${id}`,
      createdAt: new Date(START),
    });
  }
  await adapter.updateUser('alice', {
    mfaSecret: 'BASE32SECRET',
    recoveryCodeHashes: ['deadbeef'],
  });
  return { auth, adapter };
};

describe('the account directory', () => {
  test('a summary carries no password hash, no TOTP secret and no recovery hash', async () => {
    const { adapter } = await seed();
    const alice = (await adapter.findUserById('alice')) as AuthUser;
    const summary: Record<string, unknown> = { ...describeUser(alice) };
    for (const secret of ['passwordHash', 'mfaSecret', 'recoveryCodeHashes']) {
      expect(Object.hasOwn(summary, secret)).toBe(false);
    }
    // The one fact about MFA that is safe to publish, and the only one published.
    expect(summary['mfaEnrolled']).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('argon2-hash');
    expect(JSON.stringify(summary)).not.toContain('BASE32SECRET');
  });

  test('an org can be enumerated at all, which is what makes an access review answerable', async () => {
    const { auth } = await seed();
    const members = await listOrgUsers(auth, 'org-1');
    expect(members.map((member) => member.email)).toEqual(['alice@corp.test', 'zoe@corp.test']);
    expect((await listOrgUsers(auth, 'org-1', { role: 'admin' })).map((one) => one.id)).toEqual([
      'zoe',
    ]);
  });

  test('a disabled member is out of the review by default and in it on request', async () => {
    const { auth, adapter } = await seed();
    await adapter.updateUser('zoe', { disabledAt: new Date(START) });
    expect((await listOrgUsers(auth, 'org-1')).map((one) => one.id)).toEqual(['alice']);
    expect(
      (await listOrgUsers(auth, 'org-1', { includeDisabled: true })).map((one) => one.id),
    ).toEqual(['alice', 'zoe']);
  });

  test('the IdP id resolves an account — what a SCIM PUT/PATCH lands on', async () => {
    const { auth } = await seed();
    expect((await findUserByExternalId(auth, 'okta|alice'))?.id).toBe('alice');
    expect(await findUserByExternalId(auth, 'okta|nobody')).toBeNull();
  });

  test('an adapter without the read says so, with the method named', async () => {
    const legacy = new Proxy(new MemoryAdapter(), {
      get(target, prop) {
        if (prop === 'listUsersByOrg') return undefined;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AuthAdapter;
    const auth = defineAuth({ adapter: legacy, clock: frozenClock(START) });
    const thrown = await listOrgUsers(auth, 'org-1').catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_NOT_IMPLEMENTED');
    expect(error?.cause).toContain('listUsersByOrg');
  });
});
