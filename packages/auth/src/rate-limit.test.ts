import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import type { PasswordParams } from './password';
import {
  type AuthRateLimitPolicy,
  accountKey,
  createAuthLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  DEFAULT_MAX_AUTH_LIMIT_KEYS,
  ipKey,
} from './rate-limit';

// Fast KDF parameters: this suite is about the throttle, not about argon2's cost.
const FAST_PARAMS: PasswordParams = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 };

const EMAIL = 'ada@example.test';
const PASSWORD = 'correct-horse-battery-staple-42';

const newAuth = (): Auth =>
  defineAuth({
    adapter: new MemoryAdapter(),
    clock: frozenClock(1_700_000_000_000),
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, windowMs: 900_000, lockoutMs: 900_000 },
  });

const caught = async (fn: () => Promise<unknown>): Promise<AuthError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
};

const facts = (error: AuthError): Record<string, string> => ({
  code: error.code,
  title: error.title,
  cause: error.cause,
  fix: error.fix,
  rendered: error.format(),
});

describe('auth rate limiting', () => {
  test('five failed logins lock the account with X_ACCOUNT_LOCKED', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const error = await caught(() => login(auth, { email: EMAIL, password: 'wrong-password-1' }));
      expect(error.code).toBe('X_UNAUTHENTICATED');
    }

    // The sixth attempt never reaches the KDF: the bucket answers first.
    const locked = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
    expect(locked.code).toBe('X_ACCOUNT_LOCKED');
    expect(auth.limiter.lockedUntil(`account:${EMAIL}`)).not.toBeNull();
  });

  test('an unknown account and a wrong password render an identical error', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });

    const wrongPassword = await caught(() =>
      login(auth, { email: EMAIL, password: 'wrong-password-1' }),
    );
    const unknownAccount = await caught(() =>
      login(auth, { email: 'nobody@example.test', password: 'wrong-password-1' }),
    );

    // Byte-identical: nothing in the response tells an attacker the address is registered.
    expect(facts(unknownAccount)).toEqual(facts(wrongPassword));
    expect(unknownAccount.format()).not.toContain(EMAIL);
  });

  test('a successful login clears the failure window', async () => {
    const auth = newAuth();
    await register(auth, { email: EMAIL, password: PASSWORD });

    await caught(() => login(auth, { email: EMAIL, password: 'wrong-password-1' }));
    await caught(() => login(auth, { email: EMAIL, password: 'wrong-password-1' }));
    const result = await login(auth, { email: EMAIL, password: PASSWORD, ip: '203.0.113.7' });
    expect(result.actor.kind).toBe('user');

    // Four more failures would have locked a bucket that still held the earlier two.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = await caught(() => login(auth, { email: EMAIL, password: 'wrong-password-1' }));
      expect(error.code).toBe('X_UNAUTHENTICATED');
    }
  });

  // `ipKey` mints one entry per source address, so half the table is attacker-chosen: a spray
  // from an IPv6 /64 is a fresh key per attempt. These pin the two rules that keep it flat.
  describe('the table is bounded', () => {
    const policy = (over: Partial<AuthRateLimitPolicy>): AuthRateLimitPolicy => ({
      ...DEFAULT_AUTH_RATE_LIMIT,
      ...over,
    });

    test('forgets a key once its window has emptied', () => {
      const clock = frozenClock(0);
      const limiter = createAuthLimiter(clock, policy({ windowMs: 1_000, lockoutMs: 1_000 }));
      limiter.recordFailure(ipKey('198.51.100.9'));
      expect(limiter.size).toBe(1);

      // Past the window AND past the sweep interval: the entry answers as a missing one would.
      clock.advance(120_000);
      limiter.recordFailure(ipKey('203.0.113.7'));
      expect(limiter.size).toBe(1);
    });

    test('holds a locked key for the whole lockout, not just the window', () => {
      const clock = frozenClock(0);
      const limiter = createAuthLimiter(clock, policy({ windowMs: 1_000, lockoutMs: 600_000 }));
      const victim = accountKey('ada@example.test');
      for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure(victim);

      // Long past the failure window, well inside the lockout.
      clock.advance(120_000);
      limiter.recordFailure(ipKey('203.0.113.7'));
      expect(limiter.lockedUntil(victim)).not.toBeNull();
      expect(limiter.size).toBe(2);
    });

    test('a rotating-address spray cannot grow the table past its cap', () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 10 }));
      for (let index = 0; index < 500; index += 1) {
        limiter.recordFailure(ipKey(`2001:db8::${index.toString(16)}`));
        expect(limiter.size).toBeLessThanOrEqual(10);
      }
    });

    test('the cap evicts an unlocked key before a locked one', () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 4 }));
      const victim = accountKey('ada@example.test');
      for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure(victim);
      expect(limiter.lockedUntil(victim)).not.toBeNull();

      for (let index = 0; index < 200; index += 1) {
        limiter.recordFailure(ipKey(`2001:db8::${index.toString(16)}`));
      }

      expect(limiter.size).toBeLessThanOrEqual(4);
      // Filling the table is not a way to buy attempts back against one account.
      expect(limiter.lockedUntil(victim)).not.toBeNull();
    });

    test('a success and a reset both shrink the table', () => {
      const limiter = createAuthLimiter(frozenClock(0));
      limiter.recordFailure(ipKey('198.51.100.9'));
      limiter.recordFailure(accountKey('ada@example.test'));
      expect(limiter.size).toBe(2);

      limiter.recordSuccess(accountKey('ada@example.test'));
      expect(limiter.size).toBe(1);
      limiter.reset();
      expect(limiter.size).toBe(0);
    });

    test('an evicted key throttles again from a clean window, not a corrupt one', () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 1 }));
      const victim = ipKey('198.51.100.9');
      limiter.recordFailure(victim);
      limiter.recordFailure(ipKey('203.0.113.7'));

      expect(() => limiter.assertAllowed(victim)).not.toThrow();
      for (let attempt = 1; attempt <= 5; attempt += 1) limiter.recordFailure(victim);
      expect(limiter.lockedUntil(victim)).not.toBeNull();
    });

    test('the shipped policy carries a finite cap', () => {
      expect(DEFAULT_AUTH_RATE_LIMIT.maxKeys).toBe(DEFAULT_MAX_AUTH_LIMIT_KEYS);
      expect(DEFAULT_MAX_AUTH_LIMIT_KEYS).toBeGreaterThan(1_000);
      expect(Number.isFinite(DEFAULT_MAX_AUTH_LIMIT_KEYS)).toBe(true);
    });
  });

  test('the per-ip bucket locks independently of the account bucket', async () => {
    const auth = newAuth();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await caught(() =>
        login(auth, {
          email: `victim-${attempt}@example.test`,
          password: 'wrong-password-1',
          ip: '198.51.100.9',
        }),
      );
    }
    const locked = await caught(() =>
      login(auth, { email: 'victim-6@example.test', password: 'x', ip: '198.51.100.9' }),
    );
    expect(locked.code).toBe('X_ACCOUNT_LOCKED');
  });
});
