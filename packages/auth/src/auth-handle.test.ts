// Single responsibility: `login()` keyed by a handle — an app whose users sign in as `@ada` and
// keep the handle in a table of their own. The app hands `defineAuth({ handles })` the lookup;
// everything else is the email path's: one refusal for every failure, the KDF burned for an
// unknown handle, the account bucket keyed by the handle as normalised.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { configureKdfGate, resetKdfGate } from './kdf-gate';
import { memoryAuthAdapter } from './memory-adapter';

const USER_ID = '01900000-0000-7000-8000-00000000ada0';

/** An app's own `users` table, as the lookup sees it: handle → the auth user's id. */
const handleTable = new Map([['ada', USER_ID]]);

const handleAuth = (handles = true): Auth =>
  defineAuth({
    adapter: memoryAuthAdapter(),
    clock: frozenClock(1_700_000_000_000),
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 3, windowMs: 900_000, lockoutMs: 900_000 },
    ...(handles
      ? { handles: (handle: string) => Promise.resolve(handleTable.get(handle) ?? null) }
      : {}),
  });

const withAda = async (auth: Auth): Promise<Auth> => {
  await register(auth, { id: USER_ID, email: 'ada@example.test', password: PASSWORD });
  return auth;
};

describe('login by handle', () => {
  test('a handle and its password sign in as the user the app named, case and space folded', async () => {
    const auth = await withAda(handleAuth());
    const result = await login(auth, { handle: '  ADA ', password: PASSWORD });
    expect(result.actor.id).toBe(USER_ID);
    expect(result.session.userId).toBe(USER_ID);
  });

  test('register links an app-chosen id', async () => {
    const auth = await withAda(handleAuth());
    expect((await auth.adapter.findUserById(USER_ID))?.email).toBe('ada@example.test');
  });

  test('an unknown handle and a wrong password are the same refusal', async () => {
    const auth = await withAda(handleAuth());
    const unknown = await caught(() => login(auth, { handle: 'nobody', password: PASSWORD }));
    const wrong = await caught(() => login(auth, { handle: 'ada', password: 'wrong-password-x' }));
    expect(unknown?.code).toBe('X_UNAUTHENTICATED');
    expect([unknown?.code, unknown?.message]).toEqual([wrong?.code, wrong?.message]);
  });

  test('an unknown handle still runs the KDF: a gate with no room sheds it', async () => {
    const auth = await withAda(handleAuth());
    configureKdfGate({ maxConcurrent: 0, maxQueued: 0 });
    try {
      const shed = await caught(() => login(auth, { handle: 'nobody', password: PASSWORD }));
      expect(shed?.code).toBe('X_OVERLOADED');
    } finally {
      resetKdfGate();
    }
  });

  test('failures count against the handle, however it is spelled', async () => {
    const auth = await withAda(handleAuth());
    for (const spelling of ['ada', 'ADA', ' Ada ']) {
      await caught(() => login(auth, { handle: spelling, password: 'wrong-password-x' }));
    }
    const locked = await caught(() => login(auth, { handle: 'ada', password: PASSWORD }));
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });

  test('a handle login on an app that declared no handles is refused before any work', async () => {
    const auth = await withAda(handleAuth(false));
    const refused = await caught(() => login(auth, { handle: 'ada', password: PASSWORD }));
    expect(refused?.code).toBe('X_CONFIG_INVALID');
    expect(refused?.message).toContain('handles');
  });
});
