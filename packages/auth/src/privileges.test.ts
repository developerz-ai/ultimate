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

/**
 * The failure case first: a password change rotated the ONE session passed in and left every
 * other session of that user live — so the cookie somebody lifted last week survived the very
 * change made to get rid of them.
 */
describe('a changed password ends the sessions issued under the old one', () => {
  const devices = async (auth: Auth, userId: string, count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await createSession(auth.sessions, { userId, mfaSatisfied: true });
    }
  };

  test("with the caller's own session: that one survives, rotated, and it is the only one", async () => {
    const { auth, adapter, issued } = await setup();
    await devices(auth, 'alice', 3);
    const result = await updatePrivileges(
      auth,
      'alice',
      { passwordHash: 'new-hash' },
      issued.session,
    );
    expect(result.sessionsRevoked).toBe(3);
    const live = await adapter.listSessions('alice');
    expect(live.map((session) => session.id)).toEqual([result.session?.session.id ?? '']);
    expect(await adapter.getSession(issued.session.id)).toBeNull();
  });

  test('with rotation off, the session passed in is the one kept', async () => {
    const { auth, adapter, issued } = await setup({ rotateOnPrivilegeChange: false });
    await devices(auth, 'alice', 2);
    const result = await updatePrivileges(
      auth,
      'alice',
      { passwordHash: 'new-hash' },
      issued.session,
    );
    expect(result.session).toBeUndefined();
    expect(result.sessionsRevoked).toBe(2);
    expect((await adapter.listSessions('alice')).map((session) => session.id)).toEqual([
      issued.session.id,
    ]);
  });

  test('with no session — a reset — none survives', async () => {
    const { auth, adapter } = await setup();
    await devices(auth, 'alice', 2);
    const result = await updatePrivileges(auth, 'alice', { passwordHash: 'new-hash' });
    expect(result.sessionsRevoked).toBe(3);
    expect(await adapter.listSessions('alice')).toHaveLength(0);
  });

  test("an operator changing somebody else's password ends theirs and keeps the operator's", async () => {
    const { auth, adapter, issued } = await setup();
    await adapter.createUser({
      id: 'bob',
      email: 'bob@corp.test',
      passwordHash: 'old',
      orgId: 'org-1',
      roles: [],
      createdAt: new Date(START),
    });
    await devices(auth, 'bob', 2);
    const result = await updatePrivileges(auth, 'bob', { passwordHash: 'new' }, issued.session);
    expect(result.sessionsRevoked).toBe(2);
    expect(await adapter.listSessions('bob')).toHaveLength(0);
    expect(await adapter.getSession(issued.session.id)).not.toBeNull();
  });

  test('a role change still ends nothing but the rotated id', async () => {
    const { auth, adapter, issued } = await setup();
    await devices(auth, 'alice', 2);
    const result = await updatePrivileges(auth, 'alice', { roles: ['admin'] }, issued.session);
    expect(result.sessionsRevoked).toBe(0);
    expect(await adapter.listSessions('alice')).toHaveLength(3);
  });
});

/**
 * The failure case first: every rotation used to mint a session with a fresh 30-day ceiling and a
 * cookie whose `Max-Age` restarted at 30 days, so a role toggled weekly kept one login alive forever.
 */
describe('a privilege change rotates the id, never the lifetime', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('repeated grants cannot carry a session past its original ceiling', async () => {
    const clock = frozenClock(START);
    const adapter = new MemoryAdapter();
    const auth = defineAuth({ adapter, clock });
    await adapter.createUser({
      id: 'alice',
      email: 'alice@corp.test',
      passwordHash: 'argon2-hash',
      orgId: 'org-1',
      roles: ['member'],
      createdAt: new Date(START),
    });
    const first = await createSession(auth.sessions, { userId: 'alice' });
    const ceiling = first.session.absoluteExpiresAt;

    let current = first.session;
    for (const [day, role] of [
      [6, 'admin'],
      [12, 'member'],
      [29, 'admin'],
    ] as const) {
      clock.set(START + day * DAY);
      const result = await updatePrivileges(auth, 'alice', { roles: [role] }, current);
      if (result.session === undefined) expect.unreachable('a role change did not rotate');
      current = result.session.session;
      expect(current.absoluteExpiresAt).toEqual(ceiling);
      expect(current.createdAt).toEqual(first.session.createdAt);
      // The client drops the cookie when the server would, not 30 days after the last grant.
      const remaining = Math.floor((ceiling.getTime() - (START + day * DAY)) / 1000);
      expect(result.cookie).toContain(`Max-Age=${remaining};`);
    }
  });
});

describe('a privilege change on a session that is already gone', () => {
  test('refuses to resurrect it, and a password change still ends every other session', async () => {
    const { auth, adapter, issued } = await setup();
    await createSession(auth.sessions, { userId: 'alice' });
    await createSession(auth.sessions, { userId: 'alice' });
    // Signed out on another tab between this request's verify and its password change.
    await adapter.deleteSession(issued.session.id);

    const thrown = await updatePrivileges(
      auth,
      'alice',
      { passwordHash: 'new-hash' },
      issued.session,
    ).catch((error: unknown) => error);
    expect(String(thrown)).toContain('X_UNAUTHENTICATED');
    // The lifted cookies the password change was made to kill are dead all the same.
    expect(await adapter.listSessions('alice')).toEqual([]);
  });
});
