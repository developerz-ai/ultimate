import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import type { PasswordParams } from './password';

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
