// The failure case first, and it is an axiom-3 failure: `packages/auth/CLAUDE.md` has listed
// "rotate the session id on any privilege change (`rotateSession`)" as a non-negotiable, and
// `SessionPolicy.rotateOnPrivilegeChange` has defaulted `true`, while `rotateSession` had no caller
// outside its own test and the flag was read by nothing. A convention that is not a build error or
// a test does not exist. This is the test.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import { updatePrivileges } from './privileges';
import { createSession, type IssuedSession } from './session';

const START = 1_700_000_000_000;

const setup = async (
  session?: Partial<Auth['sessions']['policy']>,
): Promise<{ auth: Auth; adapter: MemoryAdapter; issued: IssuedSession }> => {
  const adapter = new MemoryAdapter();
  const auth = defineAuth({
    adapter,
    clock: frozenClock(START),
    ...(session === undefined ? {} : { session }),
  });
  await adapter.createUser({
    id: 'alice',
    email: 'alice@corp.test',
    passwordHash: 'argon2-hash',
    orgId: 'org-1',
    roles: ['member'],
    createdAt: new Date(START),
  });
  const issued = await createSession(auth.sessions, { userId: 'alice', mfaSatisfied: true });
  return { auth, adapter, issued };
};

describe('updatePrivileges', () => {
  test('a role grant rotates the session id, and the old id is gone', async () => {
    const { auth, adapter, issued } = await setup();
    const result = await updatePrivileges(auth, 'alice', { roles: ['admin'] }, issued.session);

    expect(result.user.roles).toEqual(['admin']);
    expect(result.changed).toEqual(['roles']);
    expect(result.session?.session.id).not.toBe(issued.session.id);
    // Session fixation, closed: whoever already held the old cookie does not inherit `admin`.
    expect(await adapter.getSession(issued.session.id)).toBeNull();
    expect(result.cookie).toContain('__Host-x_session=');
    // The replacement keeps the satisfied second factor — rotation is not a re-authentication.
    expect(result.session?.session.mfaSatisfied).toBe(true);
  });

  test('every field that changes what an actor may do rotates; a cosmetic one does not', async () => {
    for (const patch of [
      { roles: ['admin'] },
      { permissions: ['posts:archive'] },
      { scopes: ['tenancy:cross'] },
      { orgId: 'org-2' },
      { passwordHash: 'new-hash' },
    ]) {
      const { auth, issued } = await setup();
      const result = await updatePrivileges(auth, 'alice', patch, issued.session);
      expect(result.session).toBeDefined();
    }
    const { auth, issued } = await setup();
    const cosmetic = await updatePrivileges(
      auth,
      'alice',
      { emailVerifiedAt: new Date(START) },
      issued.session,
    );
    expect(cosmetic.changed).toEqual([]);
    expect(cosmetic.session).toBeUndefined();
  });

  test('an admin editing somebody else does not rotate a session that is not theirs', async () => {
    const { auth, adapter, issued } = await setup();
    await adapter.createUser({
      id: 'bob',
      email: 'bob@corp.test',
      passwordHash: null,
      orgId: 'org-1',
      roles: [],
      createdAt: new Date(START),
    });
    // The operator's own cookie is passed, as it would be inside a request — and it belongs to a
    // different user, so it must survive untouched.
    const result = await updatePrivileges(auth, 'bob', { roles: ['admin'] }, issued.session);
    expect(result.session).toBeUndefined();
    expect(await adapter.getSession(issued.session.id)).not.toBeNull();
  });

  test('rotateOnPrivilegeChange: false is a flag something now reads', async () => {
    const { auth, adapter, issued } = await setup({ rotateOnPrivilegeChange: false });
    const result = await updatePrivileges(auth, 'alice', { roles: ['admin'] }, issued.session);
    expect(result.changed).toEqual(['roles']);
    expect(result.session).toBeUndefined();
    expect(await adapter.getSession(issued.session.id)).not.toBeNull();
  });

  test('a write that lands no row fails closed rather than reporting a grant it did not make', async () => {
    const { auth } = await setup();
    const thrown = await updatePrivileges(auth, 'nobody', { roles: ['admin'] }).catch(
      (error: unknown) => error,
    );
    expect(String(thrown)).toContain('X_AUTH_WRITE_FAILED');
  });
});
