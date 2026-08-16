// The failure case first: IR confirms a credential compromise in one tenant at 03:00 and needs
// every session in that org killed now. `SessionStore` could delete one session, or every session
// except one, for one user — so the only options were a per-user loop over an enumeration the
// adapter could not do, or a `TRUNCATE` that took every other tenant down with it. Doing nothing
// meant thirty days, which is `absoluteTtlMs`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthAdapter } from './adapter';
import { type Auth, defineAuth } from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import {
  disableUser,
  enableUser,
  revokeOrgSessions,
  revokeSessionsCreatedBefore,
  revokeUserSessions,
} from './revocation';
import { createSession } from './session';

const START = 1_700_000_000_000;

const setup = async (): Promise<{ auth: Auth; adapter: MemoryAdapter }> => {
  const adapter = new MemoryAdapter();
  const auth = defineAuth({ adapter, clock: frozenClock(START) });
  const members: readonly [string, string | null][] = [
    ['alice', 'org-1'],
    ['bob', 'org-1'],
    ['carol', 'org-2'],
  ];
  for (const [id, orgId] of members) {
    await adapter.createUser({
      id,
      email: `${id}@corp.test`,
      passwordHash: null,
      orgId,
      roles: ['member'],
      createdAt: new Date(START),
    });
    // Two devices each, so "one session died" cannot pass for "every session died".
    await createSession(auth.sessions, { userId: id });
    await createSession(auth.sessions, { userId: id });
  }
  return { auth, adapter };
};

const liveFor = async (adapter: MemoryAdapter, userId: string): Promise<number> =>
  (await adapter.listSessions(userId)).length;

describe('revocation', () => {
  test('one org loses every session and no other tenant is touched', async () => {
    const { auth, adapter } = await setup();
    const killed = await revokeOrgSessions(auth, 'org-1', 'IR-2026-08-16 credential compromise');
    expect(killed).toBe(4);
    expect(await liveFor(adapter, 'alice')).toBe(0);
    expect(await liveFor(adapter, 'bob')).toBe(0);
    // The blast radius is the point: org-2 was never in it.
    expect(await liveFor(adapter, 'carol')).toBe(2);
  });

  test('one user loses every session, their current one included', async () => {
    const { auth, adapter } = await setup();
    expect(await revokeUserSessions(auth, 'alice', 'password changed')).toBe(2);
    expect(await liveFor(adapter, 'alice')).toBe(0);
    expect(await liveFor(adapter, 'bob')).toBe(2);
  });

  test('everything minted before an instant dies, without enumerating a single user', async () => {
    const { auth, adapter } = await setup();
    const later = defineAuth({ adapter, clock: frozenClock(START + 60_000) });
    await createSession(later.sessions, { userId: 'alice' });

    const killed = await revokeSessionsCreatedBefore(
      auth,
      new Date(START + 1),
      'SESSION_SECRET rotated',
    );
    expect(killed).toBe(6);
    // The one issued after the cutoff survives, which is what makes this usable during an
    // incident: the operator signs in again and their new session is not swept behind them.
    expect(await liveFor(adapter, 'alice')).toBe(1);
  });

  test('disableUser stamps the column nothing used to set, and kills the sessions with it', async () => {
    const { auth, adapter } = await setup();
    const result = await disableUser(auth, 'alice', 'offboarded');
    expect(result.user.disabledAt).toEqual(new Date(START));
    expect(result.sessionsRevoked).toBe(2);
    expect(await liveFor(adapter, 'alice')).toBe(0);

    // Re-enabling restores the account and deliberately not the sessions.
    const enabled = await enableUser(auth, 'alice');
    expect(enabled?.disabledAt).toBeNull();
    expect(await liveFor(adapter, 'alice')).toBe(0);
  });

  test('an adapter that has not implemented the sweep says so, with the method named', async () => {
    const adapter = new MemoryAdapter();
    // A 1.2-era adapter: the seam's new members are optional, so this still satisfies the type.
    const legacy = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'deleteSessionsForOrg') return undefined;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AuthAdapter;
    const auth = defineAuth({ adapter: legacy, clock: frozenClock(START) });
    const thrown = await revokeOrgSessions(auth, 'org-1', 'why').catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_NOT_IMPLEMENTED');
    expect(error?.cause).toContain('deleteSessionsForOrg');
    expect(error?.fix).toContain('BuiltinAdapter');
  });
});
