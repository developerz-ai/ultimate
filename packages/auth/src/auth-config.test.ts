// Single responsibility: `defineAuth`'s own contract — what an unset policy defaults to, what a
// declaration the package cannot honour is refused with, and the screen over every policy NUMBER.
// The credential flow those numbers bound is `auth.test.ts`.

import { describe, expect, test } from 'bun:test';
import { type AuthConfigInput, defineAuth } from './auth';
import { caught } from './auth-fixture';
import type { AuthError } from './errors';
import { memoryAuthAdapter } from './memory-adapter';

describe('defineAuth', () => {
  test('fills every unset policy from its default and freezes the result', () => {
    const auth = defineAuth({ adapter: memoryAuthAdapter() });
    expect(auth.mfa).toEqual({ issuer: 'Ultimate', required: false });
    // `[]`, not the live registry: an app that names no providers serves no OAuth routes. It used
    // to inherit every id `registerOAuthProvider` had written, so `defineAuth({ providers })`'s
    // own purpose — the uniform 404 for a provider this app left out — could never fire, and a
    // dependency decided which login endpoints the app answered.
    expect(auth.providers).toEqual([]);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  test('an explicit mfa issuer overrides the default without dropping the other field', () => {
    const auth = defineAuth({ adapter: memoryAuthAdapter(), mfa: { issuer: 'Postly' } });
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
      defineAuth({ adapter: memoryAuthAdapter(), mfa: declared }),
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
        defineAuth({ adapter: memoryAuthAdapter(), session: { absoluteTtlMs: value } }),
      ).toThrow(/X_CONFIG_INVALID/);
    });
  }

  test('idleTtlMs, idleSlideMs and minLength are each named in their own refusal', () => {
    expect(() =>
      defineAuth({ adapter: memoryAuthAdapter(), session: { idleTtlMs: Number.NaN } }),
    ).toThrow(/session\.idleTtlMs/);
    expect(() =>
      defineAuth({ adapter: memoryAuthAdapter(), session: { idleSlideMs: Number.NaN } }),
    ).toThrow(/session\.idleSlideMs/);
    expect(() =>
      defineAuth({ adapter: memoryAuthAdapter(), password: { minLength: Number.NaN } }),
    ).toThrow(/password\.minLength/);
  });

  test('a rate-limit number is refused as the config it is, not as a limiter mismatch', () => {
    let caught: unknown;
    try {
      defineAuth({
        adapter: memoryAuthAdapter(),
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
        adapter: memoryAuthAdapter(),
        password: { params: { algorithm: 'argon2id', memoryCost: Number.NaN, timeCost: 2 } },
      }),
    ).toThrow(/password\.params\.memoryCost/);
  });

  test('every default still builds, and so does an app that tightens them', () => {
    expect(() => defineAuth({ adapter: memoryAuthAdapter() })).not.toThrow();
    expect(() =>
      defineAuth({
        adapter: memoryAuthAdapter(),
        session: { absoluteTtlMs: 3_600_000, idleTtlMs: 900_000, idleSlideMs: 0 },
        password: { minLength: 16 },
        rateLimit: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 60_000, scope: 'process' },
      }),
    ).not.toThrow();
  });
});

/**
 * `passkeys` is a relying party, and both halves of it are load-bearing: an authenticator signs
 * `sha256(rpId)` into every assertion, and a browser refuses a ceremony whose page origin is not
 * the rpId or below it. Neither failure reaches the server — a browser raises a `SecurityError`
 * and the operator sees a login that simply does not work — so the seam is the only place these
 * can be caught. Every case below is refused BEFORE anything is built from the config.
 */
describe('defineAuth refuses a relying party no ceremony could honour', () => {
  const authWith = (passkeys: unknown) =>
    defineAuth({
      adapter: memoryAuthAdapter(),
      passkeys: passkeys as AuthConfigInput['passkeys'],
    });

  test('a valid relying party is built, screened and frozen', () => {
    const auth = authWith({ rpId: 'example.com', origins: ['https://example.com'] });
    expect(auth.passkeys).toEqual({ rpId: 'example.com', origins: ['https://example.com'] });
    expect(Object.isFrozen(auth.passkeys)).toBe(true);
    expect(Object.isFrozen(auth.passkeys.origins)).toBe(true);
    // An app that never opted in still boots; every passkey call refuses later, at first use.
    expect(defineAuth({ adapter: memoryAuthAdapter() }).passkeys).toEqual({
      rpId: '',
      origins: [],
    });
  });

  test('a subdomain origin and a loopback dev origin are both accepted', () => {
    expect(() =>
      authWith({
        rpId: 'example.com',
        origins: ['https://example.com', 'https://app.example.com'],
      }),
    ).not.toThrow();
    expect(() => authWith({ rpId: 'localhost', origins: ['http://localhost:3000'] })).not.toThrow();
  });

  /** Each case names the FIELD, because the fix differs per field and the message is the fix's context. */
  const REFUSED = [
    ['no rpId at all', { rpId: '', origins: ['https://example.com'] }, /passkeys: \{ rpId \}/],
    ['a missing rpId', { origins: ['https://example.com'] }, /passkeys: \{ rpId \}/],
    ['a scheme in the rpId', { rpId: 'https://example.com' }, /passkeys: \{ rpId \}/],
    ['a port in the rpId', { rpId: 'example.com:3000' }, /passkeys: \{ rpId \}/],
    ['a path in the rpId', { rpId: 'example.com/app' }, /passkeys: \{ rpId \}/],
    ['a trailing dot in the rpId', { rpId: 'example.com.' }, /passkeys: \{ rpId \}/],
    ['an upper-case rpId', { rpId: 'Example.com' }, /passkeys: \{ rpId \}/],
    ['an empty origins list', { rpId: 'example.com', origins: [] }, /passkeys: \{ origins \}/],
    [
      'http on a non-loopback host',
      { rpId: 'example.com', origins: ['http://example.com'] },
      /passkeys: \{ origins \}/,
    ],
    [
      'a foreign host',
      { rpId: 'example.com', origins: ['https://evil.test'] },
      /passkeys: \{ origins \}/,
    ],
    [
      'a lookalike host',
      { rpId: 'example.com', origins: ['https://example.com.evil.test'] },
      /passkeys: \{ origins \}/,
    ],
    [
      'a path in an origin',
      { rpId: 'example.com', origins: ['https://example.com/login'] },
      /passkeys: \{ origins \}/,
    ],
    ['a relative origin', { rpId: 'example.com', origins: ['/login'] }, /passkeys: \{ origins \}/],
  ] as const;

  for (const [label, passkeys, names] of REFUSED) {
    test(`${label} throws X_CONFIG_INVALID naming the field`, async () => {
      const error = await caught(async () => authWith(passkeys));
      expect(error?.code).toBe('X_CONFIG_INVALID');
      expect(error?.cause).toMatch(names);
      // The fix has to parse as configuration, not read as advice: an operator pastes it.
      expect(error?.fix).toContain('passkeys:');
      expect(error?.fix).toContain('rpId');
    });
  }

  test('a hostile rpId cannot write a second line into the one-line cause', async () => {
    const error = await caught(async () => authWith({ rpId: 'example.com\nevil', origins: [] }));
    expect(error?.code).toBe('X_CONFIG_INVALID');
    expect(error?.cause).not.toContain('\n');
  });
});
