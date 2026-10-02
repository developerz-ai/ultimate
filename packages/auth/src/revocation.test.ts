// The failure case first: IR confirms a credential compromise in one tenant at 03:00 and needs
// every session in that org killed now. `SessionStore` could delete one session, or every session
// except one, for one user — so the only options were a per-user loop over an enumeration the
// adapter could not do, or a `TRUNCATE` that took every other tenant down with it. Doing nothing
// meant thirty days, which is `absoluteTtlMs`.

import { describe, expect, test } from 'bun:test';
import { frozenClock, setLogSink } from '@ultimat3/core';
import { issueApiKey, verifyApiKey } from './api-keys';
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
    expect(result.apiKeysRevoked).toBe(0);
    expect(await liveFor(adapter, 'alice')).toBe(0);

    // Re-enabling restores the account and deliberately not the sessions.
    const enabled = await enableUser(auth, 'alice');
    expect(enabled?.disabledAt).toBeNull();
    expect(await liveFor(adapter, 'alice')).toBe(0);
  });

  // The failure case first: a disabled user's sessions died and their api keys did not, so every
  // bearer mount and MCP endpoint went on answering for someone who had been offboarded.
  test('disableUser revokes the live keys the user owns, and only those', async () => {
    const { auth, adapter } = await setup();
    const clock = frozenClock(START);
    const mine = issueApiKey({ env: 'prod', scopes: ['post:read'], userId: 'alice', clock });
    const spent = issueApiKey({ env: 'prod', scopes: ['post:read'], userId: 'alice', clock });
    const theirs = issueApiKey({ env: 'prod', scopes: ['post:read'], userId: 'bob', clock });
    for (const issued of [mine, spent, theirs]) await adapter.putApiKey(issued.record);
    await adapter.revokeApiKey(spent.record.id, new Date(START - 1_000));

    const result = await disableUser(auth, 'alice', 'offboarded');
    // One, not two: a key already revoked is not revoked again, and its instant is not moved.
    expect(result.apiKeysRevoked).toBe(1);
    expect((await adapter.findApiKeyById(mine.record.id))?.revokedAt).toEqual(new Date(START));
    expect((await adapter.findApiKeyById(spent.record.id))?.revokedAt).toEqual(
      new Date(START - 1_000),
    );
    expect((await adapter.findApiKeyById(theirs.record.id))?.revokedAt).toBeNull();

    // Re-enabling restores the account and deliberately not the key.
    await enableUser(auth, 'alice');
    const refused = await verifyApiKey(adapter, mine.plaintext, clock).catch((e: unknown) => e);
    expect(refused instanceof AuthError ? refused.code : 'verified').toBe('X_API_KEY_INVALID');
  });

  // `disableUser` wrote first and logged second, so a failed write left no line saying who asked
  // for the account to be disabled, or why.
  test('disableUser logs before its first write', async () => {
    const { auth, adapter } = await setup();
    const order: string[] = [];
    const update = adapter.updateUser.bind(adapter);
    adapter.updateUser = async (id, patch) => {
      order.push('write');
      return await update(id, patch);
    };
    const previous = setLogSink((line) => {
      if (line.includes('auth.revocation') && line.includes('offboarded')) order.push('log');
    });
    try {
      await disableUser(auth, 'alice', 'offboarded');
    } finally {
      setLogSink(previous);
    }
    expect(order).toEqual(['log', 'write']);
  });
});
