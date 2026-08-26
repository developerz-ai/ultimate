// Single responsibility: the two buckets a failed login counts against beside the account's own —
// the TENANT and the source ADDRESS. Both exist because the account bucket cannot see the attack:
// a spray never spends one account's allowance, so nothing else would ever refuse it.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { MemoryAdapter } from './memory-adapter';
import { type AuthRateLimitPolicy, ORG_ATTEMPT_FACTOR } from './rate-limit';

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
