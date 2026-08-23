// Covers the highest-risk paths in the package: `login`/`register`/`authenticate`/`logout`.
// Every failure branch is asserted by error code, not just "it throws" — a credential path that
// throws the wrong code is as dangerous as one that does not throw at all.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthAdapter } from './adapter';
import {
  type Auth,
  type AuthConfigInput,
  authenticate,
  defineAuth,
  login,
  logout,
  register,
} from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import type { PasswordParams } from './password';
import { hashPassword } from './password';
import { type AuthRateLimitPolicy, ORG_ATTEMPT_FACTOR } from './rate-limit';

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
    // `[]`, not the live registry: an app that names no providers serves no OAuth routes. It used
    // to inherit every id `registerOAuthProvider` had written, so `defineAuth({ providers })`'s
    // own purpose — the uniform 404 for a provider this app left out — could never fire, and a
    // dependency decided which login endpoints the app answered.
    expect(auth.providers).toEqual([]);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  test('an explicit mfa issuer overrides the default without dropping the other field', () => {
    const auth = defineAuth({ adapter: new MemoryAdapter(), mfa: { issuer: 'Postly' } });
    expect(auth.mfa).toEqual({ issuer: 'Postly', required: false });
  });

  /**
   * `mfa: { required: true }` reads as "this deployment requires a second factor" and nothing in
   * this package could ever have made it true: `login()` branches on `user.mfaSecret` alone, so an
   * un-enrolled user was handed a fully-privileged session under it. A declaration whose guarantee
   * cannot be shown to hold is refused where it is made — `assertAuthLimiterPolicy`, called three
   * lines above it in `defineAuth`, is the same refusal for the same reason.
   */
  test('a declared mfa.required is refused at boot, never believed at a login', async () => {
    // The field's type is the literal `false`, so this is the JS caller and the JSON-sourced
    // config the compile error cannot reach — the half the runtime refusal exists for.
    const declared = { required: true } as unknown as AuthConfigInput['mfa'];
    const error = await caught(async () =>
      defineAuth({ adapter: new MemoryAdapter(), mfa: declared }),
    );
    expect(error?.code).toBe('X_CONFIG_INVALID');
    // NAMES THE KEY, because the field exists — `README.md` says so, and an upgrader arriving
    // from a config that set it must read a refusal about `required`, not an unknown-key error
    // about a field that was deleted.
    expect(error?.cause).toContain('required');
    // The fix has to be executable: it names the check an app writes instead.
    expect(error?.fix).toContain('mfaSecret');
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

/**
 * The failure case first: one tenant's misconfigured integration hammers login from 400 source
 * addresses. Every per-IP bucket allows its own quota, the per-account buckets protect
 * individuals, and nothing caps the TENANT — so the shared limiter saturates and every other
 * tenant's logins slow down behind it.
 */
describe('the tenant bucket', () => {
  const tenantAuth = (overrides: Partial<AuthRateLimitPolicy> = {}): Auth =>
    defineAuth({
      adapter: new MemoryAdapter(),
      clock: frozenClock(1_700_000_000_000),
      password: { minLength: 12, params: FAST_PARAMS },
      rateLimit: { maxAttempts: 50, orgMaxAttempts: 3, ...overrides },
    });

  const member = async (auth: Auth, email: string): Promise<void> => {
    await register(auth, { email, password: PASSWORD, orgId: 'org-1' });
  };

  test('a spray across many members from many addresses is capped by the org', async () => {
    const auth = tenantAuth();
    await member(auth, 'a@corp.test');
    await member(auth, 'b@corp.test');
    await member(auth, 'c@corp.test');
    // Three different accounts, three different addresses: neither the account bucket
    // (maxAttempts 50) nor the ip bucket sees more than one failure.
    for (const [index, email] of ['a@corp.test', 'b@corp.test', 'c@corp.test'].entries()) {
      const failure = await caught(() =>
        login(auth, { email, password: 'wrong-password-entirely', ip: `203.0.113.${index}` }),
      );
      expect(failure?.code).toBe('X_UNAUTHENTICATED');
    }
    // The fourth attempt is refused by the tenant cap, before the KDF runs.
    const locked = await caught(() =>
      login(auth, { email: 'a@corp.test', password: PASSWORD, ip: '203.0.113.99' }),
    );
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
    expect(locked?.cause).toContain('org:org-1');
  });

  test('another tenant is unaffected by the first tenant being locked out', async () => {
    const auth = tenantAuth();
    await member(auth, 'a@corp.test');
    await register(auth, { email: 'z@other.test', password: PASSWORD, orgId: 'org-2' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await caught(() => login(auth, { email: 'a@corp.test', password: 'no', ip: '198.51.100.1' }));
    }
    // org-1 is locked; org-2 signs in normally, which is the whole point of a per-tenant key.
    expect(
      (await caught(() => login(auth, { email: 'a@corp.test', password: PASSWORD })))?.code,
    ).toBe('X_ACCOUNT_LOCKED');
    const ok = await login(auth, { email: 'z@other.test', password: PASSWORD });
    expect(ok.actor.orgId).toBe('org-2');
  });

  test('one member signing in does not clear the count a broken integration is running up', async () => {
    const auth = tenantAuth();
    await member(auth, 'a@corp.test');
    await member(auth, 'b@corp.test');
    await caught(() => login(auth, { email: 'a@corp.test', password: 'no' }));
    await caught(() => login(auth, { email: 'a@corp.test', password: 'no' }));
    // A success clears the ACCOUNT window — a legitimate user is not punished for a typo — and
    // deliberately not the tenant one, or the traffic that proves the tenant is alive is also
    // the traffic that resets its cap.
    await login(auth, { email: 'b@corp.test', password: PASSWORD });
    await caught(() => login(auth, { email: 'a@corp.test', password: 'no' }));
    expect(
      (await caught(() => login(auth, { email: 'b@corp.test', password: PASSWORD })))?.code,
    ).toBe('X_ACCOUNT_LOCKED');
  });

  test('the tenant allowance defaults to a multiple of the individual one, never to it', () => {
    const auth = defineAuth({ adapter: new MemoryAdapter(), rateLimit: { maxAttempts: 5 } });
    // Five attempts shared by a whole tenant is a denial of service against that tenant.
    expect(auth.orgRateLimit.maxAttempts).toBe(5 * ORG_ATTEMPT_FACTOR);
    expect(auth.rateLimit.maxAttempts).toBe(5);
  });
});

/**
 * The per-IP bucket, and the one line that made it inert.
 *
 * `recordSuccess(ipKey(ip))` on a successful login DELETED the whole bucket — while the three
 * lines immediately below it argue the opposite for the tenant bucket ("one member signing in
 * successfully must not clear the count a broken integration is running up beside them"). That
 * argument applies verbatim to a shared source address, which is what the IP bucket is FOR.
 *
 * The attack it enabled: four wrong guesses, one successful login against an account the attacker
 * owns, repeat. A credential-stuffing run never spends `maxAttempts` guesses on one account, so
 * the per-account bucket never fires — the IP bucket was the only one that could see the pattern,
 * and every success wiped it. Measured before the fix: 5 guesses to `X_ACCOUNT_LOCKED` without
 * the reset, 160 and still unlocked with it.
 *
 * The trade is a shared NAT accumulating failures, which is what `windowMs` exists to bound.
 */
describe('a success does not clear the address that produced the failures', () => {
  const IP = '203.0.113.7';
  const sprayAuth = (): Auth =>
    defineAuth({
      adapter: new MemoryAdapter(),
      clock: frozenClock(1_700_000_000_000),
      password: { minLength: 12, params: FAST_PARAMS },
      // A high org cap so the tenant bucket cannot be what refuses; this is about the IP one.
      rateLimit: { maxAttempts: 5, orgMaxAttempts: 10_000, windowMs: 900_000 },
    });

  test('a spray interleaved with the attacker’s own successful logins still locks the address', async () => {
    const auth = sprayAuth();
    await register(auth, { email: 'mine@evil.test', password: PASSWORD });
    const victims = ['a@corp.test', 'b@corp.test', 'c@corp.test', 'd@corp.test'];
    for (const victim of victims) {
      await register(auth, { email: victim, password: PASSWORD });
    }

    // Four wrong guesses, each against a DIFFERENT account, so no account bucket ever passes 1.
    for (const victim of victims) {
      const failure = await caught(() =>
        login(auth, { email: victim, password: 'wrong-password-entirely', ip: IP }),
      );
      expect(failure?.code).toBe('X_UNAUTHENTICATED');
    }

    // The reset move: sign in to an account the attacker controls, from the same address. It is
    // still ALLOWED here — the bucket holds 4 of 5 — which is what made it a usable escape.
    await login(auth, { email: 'mine@evil.test', password: PASSWORD, ip: IP });

    // Guess five fills the bucket; guess six is refused, and refused by the ADDRESS. With the
    // reset in place this loop ran 160 times and never locked.
    const codes: (string | undefined)[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      codes.push(
        (
          await caught(() =>
            login(auth, { email: 'a@corp.test', password: 'wrong-password-entirely', ip: IP }),
          )
        )?.code,
      );
    }
    expect(codes).toEqual(['X_UNAUTHENTICATED', 'X_ACCOUNT_LOCKED']);
    // The address, not the account: `a@corp.test` has two failures of its own against a cap of 5.
    const locked = await caught(() =>
      login(auth, { email: 'mine@evil.test', password: PASSWORD, ip: IP }),
    );
    expect(locked?.cause).toContain(IP);
  });

  test('the ACCOUNT window is still cleared by a success — a typo must not cost a lockout', async () => {
    const auth = sprayAuth();
    await register(auth, { email: 'ada@corp.test', password: PASSWORD });
    // No `ip` at all, so only the account bucket is in play.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await caught(() => login(auth, { email: 'ada@corp.test', password: 'typo' }));
    }
    await login(auth, { email: 'ada@corp.test', password: PASSWORD });
    // Four more would exceed 5 in the window if the success had not cleared it.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        (await caught(() => login(auth, { email: 'ada@corp.test', password: 'typo' })))?.code,
      ).toBe('X_UNAUTHENTICATED');
    }
  });
});
