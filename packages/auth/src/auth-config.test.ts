// Single responsibility: `defineAuth`'s own contract — what an unset policy defaults to, what a
// declaration the package cannot honour is refused with, and the screen over every policy NUMBER.
// The credential flow those numbers bound is `auth.test.ts`.

import { describe, expect, test } from 'bun:test';
import { type AuthConfigInput, defineAuth } from './auth';
import { caught } from './auth-fixture';
import type { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';

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

/**
 * `defineAuth` is where a deployment states the three numbers a session and a password rest on,
 * and every one of them arrives as `Number(process.env.…)` as often as a literal — which is `NaN`
 * for an unset variable. `NaN` is not nullish, so the spread over the defaults keeps it, and every
 * comparison it then reaches answers FALSE. Measured against the code before this screen:
 *
 * | declared | what the auth path then did |
 * |---|---|
 * | `session.absoluteTtlMs: NaN` | `absoluteExpiresAt` is an Invalid Date and `now >= NaN` is false — the session NEVER absolutely expires |
 * | `session.idleTtlMs: NaN` | `now - lastSeenAt >= NaN` is false — a session idle since 2000 reports `idleExpired: false` |
 * | `password.minLength: NaN` | `password.length < NaN` is false, and the two-distinct-characters rule is guarded by `length > 0` — so the EMPTY password was accepted |
 *
 * None of the three threw, logged or degraded. `rateLimit.maxAttempts: NaN` was already refused,
 * but as `X_AUTH_LIMITER_POLICY_MISMATCH` — the limiter comparing `NaN === NaN` — which names the
 * limiter rather than the typo.
 */
describe('defineAuth refuses a policy number that is not a number', () => {
  const NOT_A_DURATION = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1] as const;

  for (const value of NOT_A_DURATION) {
    test(`session.absoluteTtlMs: ${String(value)} never mints an unexpiring session`, () => {
      expect(() =>
        defineAuth({ adapter: new MemoryAdapter(), session: { absoluteTtlMs: value } }),
      ).toThrow(/X_CONFIG_INVALID/);
    });
  }

  test('idleTtlMs, idleSlideMs and minLength are each named in their own refusal', () => {
    expect(() =>
      defineAuth({ adapter: new MemoryAdapter(), session: { idleTtlMs: Number.NaN } }),
    ).toThrow(/session\.idleTtlMs/);
    expect(() =>
      defineAuth({ adapter: new MemoryAdapter(), session: { idleSlideMs: Number.NaN } }),
    ).toThrow(/session\.idleSlideMs/);
    expect(() =>
      defineAuth({ adapter: new MemoryAdapter(), password: { minLength: Number.NaN } }),
    ).toThrow(/password\.minLength/);
  });

  test('a rate-limit number is refused as the config it is, not as a limiter mismatch', () => {
    let caught: unknown;
    try {
      defineAuth({
        adapter: new MemoryAdapter(),
        rateLimit: { maxAttempts: Number.NaN, scope: 'process' },
      });
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as AuthError).code).toBe('X_CONFIG_INVALID');
    expect((caught as AuthError).cause).toContain('rateLimit.maxAttempts');
  });

  test('the argon2 cost parameters are screened too — argon2 throws deep, this names the key', () => {
    expect(() =>
      defineAuth({
        adapter: new MemoryAdapter(),
        password: { params: { algorithm: 'argon2id', memoryCost: Number.NaN, timeCost: 2 } },
      }),
    ).toThrow(/password\.params\.memoryCost/);
  });

  test('every default still builds, and so does an app that tightens them', () => {
    expect(() => defineAuth({ adapter: new MemoryAdapter() })).not.toThrow();
    expect(() =>
      defineAuth({
        adapter: new MemoryAdapter(),
        session: { absoluteTtlMs: 3_600_000, idleTtlMs: 900_000, idleSlideMs: 0 },
        password: { minLength: 16 },
        rateLimit: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 60_000, scope: 'process' },
      }),
    ).not.toThrow();
  });
});
