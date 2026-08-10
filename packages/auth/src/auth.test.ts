// Covers the highest-risk paths in the package: `login`/`register`/`authenticate`/`logout`.
// Every failure branch is asserted by error code, not just "it throws" — a credential path that
// throws the wrong code is as dangerous as one that does not throw at all.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthAdapter } from './adapter';
import { type Auth, authenticate, defineAuth, login, logout, register } from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import type { PasswordParams } from './password';
import { hashPassword } from './password';

/** Same adapter, except `findUserById` answers "gone" — simulates a user row disappearing
 *  (hard delete, another process) without its session being cleaned up alongside it. Bound to
 *  `base` explicitly so `MemoryAdapter`'s private fields resolve against the real instance. */
function withUserGone(base: AuthAdapter): AuthAdapter {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'findUserById') return () => Promise.resolve(null);
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Fast KDF parameters: these tests are about the credential flow, not argon2's cost.
const FAST_PARAMS: PasswordParams = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 };

const EMAIL = 'ADA@Example.test';
const NORMALISED_EMAIL = 'ada@example.test';
const PASSWORD = 'correct-horse-battery-staple-42';

const newAuth = (adapter = new MemoryAdapter(), startMs = 1_700_000_000_000): Auth =>
  defineAuth({
    adapter,
    clock: frozenClock(startMs),
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, windowMs: 900_000, lockoutMs: 900_000 },
  });

/** Captures the thrown `AuthError`, or `undefined` when the call unexpectedly resolved. The
 *  caller's `expect(error?.code).toBe(...)` is then the assertion that fails, naming the code it
 *  wanted — a sentinel thrown from in here would carry no code and no fix. Anything that is not
 *  an `AuthError` is rethrown untouched: this helper never swallows an unexpected failure. */
const caught = async (fn: () => Promise<unknown>): Promise<AuthError | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
};

describe('defineAuth', () => {
  test('fills every unset policy from its default and freezes the result', () => {
    const auth = defineAuth({ adapter: new MemoryAdapter() });
    expect(auth.mfa).toEqual({ issuer: 'Ultimate', required: false });
    expect(auth.providers.length).toBeGreaterThan(0);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  test('an explicit mfa issuer overrides the default without dropping the other field', () => {
    const auth = defineAuth({ adapter: new MemoryAdapter(), mfa: { issuer: 'Postly' } });
    expect(auth.mfa).toEqual({ issuer: 'Postly', required: false });
  });
});

describe('register', () => {
  test('lowercases and trims the email, and never stores the plaintext password', async () => {
    const auth = newAuth();
    const user = await register(auth, { email: `  ${EMAIL}  `, password: PASSWORD });
    expect(user.email).toBe(NORMALISED_EMAIL);
    expect(user.passwordHash).not.toBeNull();
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  test('a weak password is rejected before any user is created', async () => {
    const auth = newAuth();
    const error = await caught(() => register(auth, { email: EMAIL, password: 'short' }));
    expect(error?.code).toBe('X_PASSWORD_WEAK');
    expect(await auth.adapter.findUserByEmail(NORMALISED_EMAIL)).toBeNull();
  });
});

describe('login', () => {
  test('a correct password returns an actor, a fresh session and a cookie', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });

    const result = await login(auth, { email: EMAIL, password: PASSWORD, ip: '203.0.113.7' });
    expect(result.actor.kind).toBe('user');
    expect(result.session.mfaSatisfied).toBe(true);
    expect(result.token).toBe(`${result.session.id}.${result.token.split('.')[1]}`);
    expect(result.cookie.startsWith('__Host-x_session=')).toBe(true);
    expect(await auth.adapter.getSession(result.session.id)).not.toBeNull();
  });

  test('a wrong password is rejected as loginFailed, not a more specific error', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });
    const error = await caught(() => login(auth, { email: EMAIL, password: 'nope-nope-nope' }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
  });

  test('a disabled account is rejected identically to a wrong password', async () => {
    const auth = newAuth();
    const user = await register(auth, { email: EMAIL, password: PASSWORD });
    await auth.adapter.updateUser(user.id, { disabledAt: auth.clock.now() });

    const error = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(error?.cause).not.toContain('disabled');
  });

  test('an mfa-enrolled user stops at X_MFA_REQUIRED and mints no session', async () => {
    const auth = newAuth();
    const user = await register(auth, { email: EMAIL, password: PASSWORD });
    await auth.adapter.updateUser(user.id, { mfaSecret: 'JBSWY3DPEHPK3PXP' });

    const error = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
    expect(error?.code).toBe('X_MFA_REQUIRED');
    expect(await auth.adapter.listSessions(user.id)).toHaveLength(0);
  });

  test('a hash written under weaker parameters is upgraded in place on a successful login', async () => {
    const adapter = new MemoryAdapter();
    const auth = newAuth(adapter);
    const legacyHash = await hashPassword(PASSWORD, { ...FAST_PARAMS, memoryCost: 1024 });
    const user = await adapter.createUser({
      id: 'user-legacy',
      email: EMAIL,
      passwordHash: legacyHash,
      orgId: null,
      roles: [],
      createdAt: auth.clock.now(),
    });

    await login(auth, { email: EMAIL, password: PASSWORD });

    const stored = await adapter.findUserById(user.id);
    expect(stored?.passwordHash).not.toBe(legacyHash);
    // The upgraded hash still verifies the same password.
    const relogin = await login(auth, { email: EMAIL, password: PASSWORD });
    expect(relogin.actor.kind).toBe('user');
  });
});

describe('authenticate', () => {
  test('no token resolves to an anonymous actor, not an error', async () => {
    const auth = newAuth();
    expect((await authenticate(auth, null)).kind).toBe('anonymous');
    expect((await authenticate(auth, '')).kind).toBe('anonymous');
  });

  test('a valid session token resolves to the same actor login returned', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });
    const logged = await login(auth, { email: EMAIL, password: PASSWORD });

    const actor = await authenticate(auth, logged.token);
    expect(actor).toEqual(logged.actor);
  });

  test('a forged or unknown token throws X_UNAUTHENTICATED', async () => {
    const auth = newAuth();
    const error = await caught(() => authenticate(auth, 'nonexistent-id.some-secret'));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
  });

  test('a session for a disabled user is deleted and rejected, not silently accepted', async () => {
    const auth = newAuth();
    const user = await register(auth, { email: EMAIL, password: PASSWORD });
    const logged = await login(auth, { email: EMAIL, password: PASSWORD });
    await auth.adapter.updateUser(user.id, { disabledAt: auth.clock.now() });

    const error = await caught(() => authenticate(auth, logged.token));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(await auth.adapter.getSession(logged.session.id)).toBeNull();
  });

  test('a session for a since-deleted user is deleted and rejected', async () => {
    const adapter = new MemoryAdapter();
    const auth = newAuth(adapter);
    await register(auth, { email: EMAIL, password: PASSWORD });
    const logged = await login(auth, { email: EMAIL, password: PASSWORD });

    const gone = newAuth(withUserGone(adapter));
    const error = await caught(() => authenticate(gone, logged.token));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(await adapter.getSession(logged.session.id)).toBeNull();
  });
});

describe('logout', () => {
  test('a valid token deletes its session and reports true', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });
    const logged = await login(auth, { email: EMAIL, password: PASSWORD });

    expect(await logout(auth, logged.token)).toBe(true);
    expect(await auth.adapter.getSession(logged.session.id)).toBeNull();
  });

  test('a malformed token (no separator) reports false without touching the store', async () => {
    const auth = newAuth();
    expect(await logout(auth, 'not-a-real-token')).toBe(false);
  });

  test('a well-formed but unknown session id reports false', async () => {
    const auth = newAuth();
    expect(await logout(auth, 'unknown-id.unknown-secret')).toBe(false);
  });
});
