// How many statements one authenticated request costs on the blessed adapter, counted on PGlite:
// one. The session and its user arrive in one join (`getSessionWithUser`), and the user row is still
// read on every request — never cached — so a disable lands on the very next one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type DbClient, pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { type Auth, authenticate, defineAuth } from './auth';
import { caught, FAST_PARAMS } from './auth-fixture';
import { postgresAuthAdapter } from './builtin-adapter';
import { createSession } from './session';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const NOW = new Date('2026-11-11T09:00:00.000Z');
const client = pgliteClient();
let statements = 0;

/** The PGlite client, counting every statement the adapter sends through it. */
const counted: DbClient = {
  query: (fragment) => {
    statements += 1;
    return client.query(fragment);
  },
  one: (fragment) => {
    statements += 1;
    return client.one(fragment);
  },
  execute: (fragment) => {
    statements += 1;
    return client.execute(fragment);
  },
};

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

const authOver = (adapter: AuthAdapter): Auth =>
  defineAuth({ adapter, clock: frozenClock(NOW.getTime()), password: { params: FAST_PARAMS } });

/** A user and a live session for it, the token the cookie would carry, and the count reset. */
const signedIn = async (auth: Auth): Promise<{ userId: string; token: string }> => {
  const userId = crypto.randomUUID();
  await auth.adapter.createUser({
    id: userId,
    email: `${userId}@example.com`,
    passwordHash: null,
    orgId: null,
    roles: ['editor'],
    createdAt: NOW,
  });
  const issued = await createSession(auth.sessions, { userId });
  statements = 0;
  return { userId, token: issued.token };
};

describe('authenticate on PostgresAuthAdapter', () => {
  test('one statement: the session and its user in one join', async () => {
    const auth = authOver(postgresAuthAdapter(counted, frozenClock(NOW.getTime())));
    const { userId, token } = await signedIn(auth);
    const actor = await authenticate(auth, token);
    expect(actor.kind === 'user' ? actor.id : actor.kind).toBe(userId);
    expect(statements).toBe(1);
  });

  test('the user is re-read every request: a disable refuses the next one and drops the session', async () => {
    const adapter = postgresAuthAdapter(counted, frozenClock(NOW.getTime()));
    const auth = authOver(adapter);
    const { userId, token } = await signedIn(auth);
    await authenticate(auth, token);
    await adapter.updateUser(userId, { disabledAt: NOW });
    expect((await caught(() => authenticate(auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await adapter.listSessions(userId)).toEqual([]);
  });

  test('a wrong secret half is refused before anything is written', async () => {
    const auth = authOver(postgresAuthAdapter(counted, frozenClock(NOW.getTime())));
    const { userId, token } = await signedIn(auth);
    const forged = `${token.slice(0, token.indexOf('.'))}.not-the-secret`;
    expect((await caught(() => authenticate(auth, forged)))?.code).toBe('X_UNAUTHENTICATED');
    expect(statements).toBe(1);
    expect(await auth.adapter.listSessions(userId)).toHaveLength(1);
  });
});
