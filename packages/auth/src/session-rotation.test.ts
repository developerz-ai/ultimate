// `rotateSession` mints a new id, never a new lifetime. Rotation used to call `createSession` with
// nothing inherited, so every privilege change reset `createdAt` and the absolute ceiling: a
// session rotated often enough lived forever, and `revokeSessionsCreatedBefore` missed it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { createPgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { defineAuth } from './auth';
import { BuiltinAdapter } from './builtin-adapter';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import { revokeSessionsCreatedBefore } from './revocation';
import {
  createSession,
  DEFAULT_SESSION_POLICY,
  remainingMaxAgeSeconds,
  revokeSession,
  rotateSession,
  verifySession,
} from './session';
import { AUTH_TABLES } from './tables';

const DAY = 24 * 60 * 60 * 1000;
const START = 1_700_000_000_000;
const PGLITE_BOOT_MS = 30_000;
const ALICE = '00000000-0000-7000-8000-000000000501';

// The Postgres half on PGlite: the inherited instants have to survive a real `timestamptz`
// round trip, and the sweep is the adapter's own `created_at <` statement, not the memory filter.
const client = createPgliteClient();

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

const fresh = (
  make: (clock: ReturnType<typeof frozenClock>) => AuthAdapter = () => new MemoryAdapter(),
) => {
  const clock = frozenClock(START);
  const adapter = make(clock);
  const auth = defineAuth({ adapter, clock });
  return { adapter, clock, auth, runtime: auth.sessions };
};

const ADAPTERS = [
  ['memory', () => new MemoryAdapter()],
  ['postgres', (clock: ReturnType<typeof frozenClock>) => new BuiltinAdapter(client, clock)],
] as const;

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  const thrown = await call.then(
    () => 'did-not-throw',
    (error: unknown) => error,
  );
  return thrown instanceof AuthError ? thrown.code : String(thrown);
};

describe.each(ADAPTERS)('rotateSession on the %s adapter', (_name, make) => {
  const setup = async () => {
    const env = fresh(make);
    await env.adapter.deleteSessionsForUser(ALICE);
    if ((await env.adapter.findUserById(ALICE)) === null) {
      await env.adapter.createUser({
        id: ALICE,
        email: 'alice@corp.test',
        passwordHash: null,
        orgId: null,
        roles: [],
        createdAt: new Date(START),
      });
    }
    return env;
  };

  test('rotation keeps the absolute ceiling', async () => {
    const { clock, runtime } = await setup();
    const first = await createSession(runtime, { userId: ALICE });
    const ceiling = first.session.absoluteExpiresAt;
    expect(ceiling.getTime()).toBe(START + DEFAULT_SESSION_POLICY.absoluteTtlMs);

    // Rotated every six days — inside the 7-day idle window — and once more on day 29.
    let current = first;
    for (const day of [6, 12, 18, 24, 29]) {
      clock.set(START + day * DAY);
      const verified = await verifySession(runtime, current.token);
      current = await rotateSession(runtime, verified);
      expect(current.session.absoluteExpiresAt).toEqual(ceiling);
      expect(current.session.createdAt).toEqual(first.session.createdAt);
    }

    // The original ceiling still bites: day 30 is the end, however recently the id changed.
    clock.set(START + 30 * DAY);
    expect(await codeOf(verifySession(runtime, current.token))).toBe('X_SESSION_EXPIRED');
  });

  test('a session revoked after it was verified is not resurrected by rotation', async () => {
    const { adapter, runtime } = await setup();
    const first = await createSession(runtime, { userId: ALICE });
    const verified = await verifySession(runtime, first.token);
    // Logged out (or revoked by an operator) between the request's verify and its grant.
    await revokeSession(runtime, verified.id);

    expect(await codeOf(rotateSession(runtime, verified))).toBe('X_UNAUTHENTICATED');
    expect(await adapter.listSessions(ALICE)).toEqual([]);
  });

  test('two concurrent rotations of one session leave one live session, not two', async () => {
    const { adapter, runtime } = await setup();
    const first = await createSession(runtime, { userId: ALICE });

    const outcomes = await Promise.allSettled([
      rotateSession(runtime, first.session),
      rotateSession(runtime, first.session),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = lost[0]?.status === 'rejected' ? lost[0].reason : undefined;
    expect(reason instanceof AuthError && reason.code).toBe('X_UNAUTHENTICATED');
    const live = await adapter.listSessions(ALICE);
    expect(live.map((session) => session.id)).toEqual(
      won[0]?.status === 'fulfilled' ? [won[0].value.session.id] : [],
    );
  });

  test('a rotated session is still "created before" the instant it was first minted after', async () => {
    const { adapter, clock, auth, runtime } = await setup();
    const first = await createSession(runtime, { userId: ALICE });
    clock.set(START + 2 * DAY);
    const rotated = await rotateSession(runtime, first.session);

    // The sweep that follows a leaked SESSION_SECRET: everything minted before the leak window.
    const swept = await revokeSessionsCreatedBefore(auth, new Date(START + DAY), 'secret rotated');
    expect(swept).toBe(1);
    expect(await adapter.getSession(rotated.session.id)).toBeNull();
  });
});

describe('createSession inherits, it never extends', () => {
  test('an inherited ceiling past createdAt + absoluteTtlMs is clamped to it', async () => {
    const { runtime } = fresh();
    const issued = await createSession(runtime, {
      userId: 'alice',
      createdAt: new Date(START),
      absoluteExpiresAt: new Date(START + 365 * DAY),
    });
    expect(issued.session.absoluteExpiresAt.getTime()).toBe(
      START + DEFAULT_SESSION_POLICY.absoluteTtlMs,
    );
  });

  test('a createdAt in the future is not a way to buy lifetime', async () => {
    const { runtime } = fresh();
    const issued = await createSession(runtime, {
      userId: 'alice',
      createdAt: new Date(START + 365 * DAY),
    });
    expect(issued.session.createdAt.getTime()).toBe(START);
    expect(issued.session.absoluteExpiresAt.getTime()).toBe(
      START + DEFAULT_SESSION_POLICY.absoluteTtlMs,
    );
  });

  test('an inherited earlier ceiling is kept as it is', async () => {
    const { runtime } = fresh();
    const issued = await createSession(runtime, {
      userId: 'alice',
      createdAt: new Date(START - DAY),
      absoluteExpiresAt: new Date(START + DAY),
    });
    expect(issued.session.createdAt.getTime()).toBe(START - DAY);
    expect(issued.session.absoluteExpiresAt.getTime()).toBe(START + DAY);
  });
});

describe('remainingMaxAgeSeconds', () => {
  test('counts down to the ceiling, and never below zero', async () => {
    const { runtime } = fresh();
    const { session } = await createSession(runtime, { userId: 'alice' });
    expect(remainingMaxAgeSeconds(session, new Date(START))).toBe(
      DEFAULT_SESSION_POLICY.absoluteTtlMs / 1000,
    );
    expect(remainingMaxAgeSeconds(session, new Date(START + 10 * DAY + 500))).toBe(
      (DEFAULT_SESSION_POLICY.absoluteTtlMs - 10 * DAY) / 1000 - 1,
    );
    expect(remainingMaxAgeSeconds(session, new Date(START + 31 * DAY))).toBe(0);
  });
});
