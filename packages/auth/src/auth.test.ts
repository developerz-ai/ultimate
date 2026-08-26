// Covers the highest-risk paths in the package: `login`/`register`/`authenticate`/`logout`.
// Every failure branch is asserted by error code, not just "it throws" — a credential path that
// throws the wrong code is as dangerous as one that does not throw at all. `defineAuth`'s own
// contract is `auth-config.test.ts`; the buckets a failed login counts against are
// `auth-lockout.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthAdapter } from './adapter';
import { type Auth, authenticate, defineAuth, login, logout, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { MemoryAdapter } from './memory-adapter';
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

const EMAIL = 'ADA@Example.test';
const NORMALISED_EMAIL = 'ada@example.test';

// `adapter: AuthAdapter`, annotated rather than inferred from the default: without it the
// parameter reads as the concrete `MemoryAdapter`, and no helper that takes an adapter — the
// `withUserGone` proxy above, any app's real adapter — can be handed to it.
const newAuth = (adapter: AuthAdapter = new MemoryAdapter(), startMs = 1_700_000_000_000): Auth =>
  defineAuth({
    adapter,
    clock: frozenClock(startMs),
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, windowMs: 900_000, lockoutMs: 900_000 },
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

  /**
   * The lockout analysis, executable. Refusing an un-enrolled user inside `login()` would refuse
   * exactly the people with no second factor to offer, and this package ships no enrolment route,
   * no pending-MFA credential and no half-authenticated actor for them — `actorFromUser` strips
   * privileges only when `mfaSecret !== null`. A session is therefore the only door to enrolment,
   * and this test is what stops a later "enforce it" change from closing that door for good.
   */
  test('a user with no second factor still signs in, so enrolment stays reachable', async () => {
    const auth = defineAuth({
      adapter: new MemoryAdapter(),
      clock: frozenClock(1_700_000_000_000),
      password: { minLength: 12, params: FAST_PARAMS },
      mfa: { issuer: 'Postly' },
    });
    const user = await register(auth, { email: EMAIL, password: PASSWORD });
    expect(user.mfaSecret).toBeNull();

    const result = await login(auth, { email: EMAIL, password: PASSWORD });
    expect(result.session.mfaSatisfied).toBe(true);
    // The enrolment write the app's own route makes with that session, and it still resolves.
    const enrolled = await auth.adapter.updateUser(user.id, { mfaSecret: 'JBSWY3DPEHPK3PXP' });
    expect(enrolled?.mfaSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  test('a hash written under weaker parameters is upgraded in place on a successful login', async () => {
    const adapter = new MemoryAdapter();
    const auth = newAuth(adapter);
    const legacyHash = await hashPassword(PASSWORD, { ...FAST_PARAMS, memoryCost: 1024 });
    const user = await adapter.createUser({
      id: 'user-legacy',
      // Seeding the adapter directly bypasses `register()`, which is the one place an address is
      // normalised — so the fixture has to store what `register()` would have. Handing the raw
      // `EMAIL` here made this test pass only against the memory adapter's own case folding, and
      // the identical scenario against Postgres found no row at all.
      email: NORMALISED_EMAIL,
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

  // The id half of a session token is not a credential — the secret half is, and `verifySession`
  // has always checked it. Deleting on the id alone made "sign this person out" reachable by
  // anyone who ever saw an id, and an id reaches a device list and a log line the token never does.
  test('the right session id with the wrong secret deletes nothing', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });
    const logged = await login(auth, { email: EMAIL, password: PASSWORD });

    expect(await logout(auth, `${logged.session.id}.not-the-secret`)).toBe(false);
    expect(await auth.adapter.getSession(logged.session.id)).not.toBeNull();
    // The real token still works afterwards, so the refusal did not consume the session either.
    expect(await logout(auth, logged.token)).toBe(true);
  });
});
