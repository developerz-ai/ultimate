import { describe, expect, test } from 'bun:test';
import { type Clock, frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import type { PasswordParams } from './password';
import {
  type AuthLimiter,
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
    expect(await auth.limiter.lockedUntil(`account:${EMAIL}`)).not.toBeNull();
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

    test('forgets a key once its window has emptied', async () => {
      const clock = frozenClock(0);
      const limiter = createAuthLimiter(clock, policy({ windowMs: 1_000, lockoutMs: 1_000 }));
      await limiter.recordFailure(ipKey('198.51.100.9'));
      expect(limiter.size).toBe(1);

      // Past the window AND past the sweep interval: the entry answers as a missing one would.
      clock.advance(120_000);
      await limiter.recordFailure(ipKey('203.0.113.7'));
      expect(limiter.size).toBe(1);
    });

    test('holds a locked key for the whole lockout, not just the window', async () => {
      const clock = frozenClock(0);
      const limiter = createAuthLimiter(clock, policy({ windowMs: 1_000, lockoutMs: 600_000 }));
      const victim = accountKey('ada@example.test');
      for (let attempt = 1; attempt <= 5; attempt += 1) await limiter.recordFailure(victim);

      // Long past the failure window, well inside the lockout.
      clock.advance(120_000);
      await limiter.recordFailure(ipKey('203.0.113.7'));
      expect(await limiter.lockedUntil(victim)).not.toBeNull();
      expect(limiter.size).toBe(2);
    });

    test('a rotating-address spray cannot grow the table past its cap', async () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 10 }));
      for (let index = 0; index < 500; index += 1) {
        await limiter.recordFailure(ipKey(`2001:db8::${index.toString(16)}`));
        expect(limiter.size).toBeLessThanOrEqual(10);
      }
    });

    test('the cap evicts an unlocked key before a locked one', async () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 4 }));
      const victim = accountKey('ada@example.test');
      for (let attempt = 1; attempt <= 5; attempt += 1) await limiter.recordFailure(victim);
      expect(await limiter.lockedUntil(victim)).not.toBeNull();

      for (let index = 0; index < 200; index += 1) {
        await limiter.recordFailure(ipKey(`2001:db8::${index.toString(16)}`));
      }

      expect(limiter.size).toBeLessThanOrEqual(4);
      // Filling the table is not a way to buy attempts back against one account.
      expect(await limiter.lockedUntil(victim)).not.toBeNull();
    });

    test('a success and a reset both shrink the table', async () => {
      const limiter = createAuthLimiter(frozenClock(0));
      await limiter.recordFailure(ipKey('198.51.100.9'));
      await limiter.recordFailure(accountKey('ada@example.test'));
      expect(limiter.size).toBe(2);

      await limiter.recordSuccess(accountKey('ada@example.test'));
      expect(limiter.size).toBe(1);
      await limiter.reset();
      expect(limiter.size).toBe(0);
    });

    test('an evicted key throttles again from a clean window, not a corrupt one', async () => {
      const limiter = createAuthLimiter(frozenClock(0), policy({ maxKeys: 1 }));
      const victim = ipKey('198.51.100.9');
      await limiter.recordFailure(victim);
      await limiter.recordFailure(ipKey('203.0.113.7'));

      await expect(limiter.assertAllowed(victim)).resolves.toBeUndefined();
      for (let attempt = 1; attempt <= 5; attempt += 1) await limiter.recordFailure(victim);
      expect(await limiter.lockedUntil(victim)).not.toBeNull();
    });

    test('the shipped policy carries a finite cap', () => {
      expect(DEFAULT_AUTH_RATE_LIMIT.maxKeys).toBe(DEFAULT_MAX_AUTH_LIMIT_KEYS);
      expect(DEFAULT_MAX_AUTH_LIMIT_KEYS).toBeGreaterThan(1_000);
      expect(Number.isFinite(DEFAULT_MAX_AUTH_LIMIT_KEYS)).toBe(true);
    });
  });

  /**
   * A lockout is a count of attempts against one identity, so it has to be one count. Two `Auth`
   * runtimes stand in for two replicas of a deployment: each holding its own table means the
   * account survives `maxAttempts × replicas` guesses, and the lockout one replica established
   * is invisible to the others.
   */
  describe('a lockout that must hold across replicas', () => {
    /** One process standing in for a shared tier: the memory limiter, declared shared. */
    const shared = (clock: Clock, over: Partial<AuthRateLimitPolicy> = {}): AuthLimiter => {
      const enforced: AuthRateLimitPolicy = {
        ...DEFAULT_AUTH_RATE_LIMIT,
        maxAttempts: 5,
        windowMs: 900_000,
        lockoutMs: 900_000,
        ...over,
        scope: 'shared',
      };
      const backing = createAuthLimiter(clock, enforced);
      return {
        policy: enforced,
        assertAllowed: backing.assertAllowed,
        recordFailure: backing.recordFailure,
        recordSuccess: backing.recordSuccess,
        lockedUntil: backing.lockedUntil,
        reset: backing.reset,
      };
    };

    test('two replicas behind one limiter lock at the configured count, not twice it', async () => {
      const clock = frozenClock(1_700_000_000_000);
      const adapter = new MemoryAdapter();
      const limiter = shared(clock);
      const replica = (): Auth =>
        defineAuth({
          adapter,
          clock,
          limiter,
          password: { minLength: 12, params: FAST_PARAMS },
          rateLimit: { maxAttempts: 5, windowMs: 900_000, lockoutMs: 900_000, scope: 'shared' },
        });
      const a = replica();
      const b = replica();
      await register(a, { email: EMAIL, password: PASSWORD });

      // Five failures spread across both replicas — the attacker picks which one answers.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const error = await caught(() =>
          login(attempt % 2 === 0 ? a : b, { email: EMAIL, password: 'wrong-password-1' }),
        );
        expect(error.code).toBe('X_UNAUTHENTICATED');
      }

      // The correct password on the replica that saw only two of them: still locked out.
      const locked = await caught(() => login(b, { email: EMAIL, password: PASSWORD }));
      expect(locked.code).toBe('X_ACCOUNT_LOCKED');
    });

    test('a shared declaration with a per-process limiter refuses at defineAuth', () => {
      expect(() =>
        defineAuth({
          adapter: new MemoryAdapter(),
          clock: frozenClock(0),
          rateLimit: { scope: 'shared' },
        }),
      ).toThrow(/X_AUTH_LIMITER_NOT_SHARED/);
    });

    test('the default declaration still builds the in-memory limiter', () => {
      expect(newAuth().limiter.policy.scope).toBe('process');
    });

    /**
     * `Auth.rateLimit` is a public field an operator reads as "what this deployment enforces". A
     * limiter carrying different numbers makes that field a claim nothing backs — the same failure
     * class as the per-replica multiplication: a number the operator believes and nothing enforces.
     */
    test('a limiter enforcing other numbers than the app declared refuses at defineAuth', () => {
      const clock = frozenClock(0);
      const generous = shared(clock, { maxAttempts: 50 });
      expect(() =>
        defineAuth({
          adapter: new MemoryAdapter(),
          clock,
          limiter: generous,
          rateLimit: { maxAttempts: 5, scope: 'shared' },
        }),
      ).toThrow(/X_AUTH_LIMITER_POLICY_MISMATCH/);
    });

    test('the same numbers on both sides boot, and every field is compared', () => {
      const clock = frozenClock(0);
      const declared = { maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 };
      expect(() =>
        defineAuth({
          adapter: new MemoryAdapter(),
          clock,
          limiter: shared(clock, declared),
          rateLimit: { ...declared, scope: 'shared' },
        }),
      ).not.toThrow();

      for (const drift of [{ windowMs: 60_001 }, { lockoutMs: 1 }, { maxAttempts: 4 }]) {
        expect(() =>
          defineAuth({
            adapter: new MemoryAdapter(),
            clock,
            limiter: shared(clock, { ...declared, ...drift }),
            rateLimit: { ...declared, scope: 'shared' },
          }),
        ).toThrow(/X_AUTH_LIMITER_POLICY_MISMATCH/);
      }
    });

    // `maxKeys` bounds one process' table, so a shared limiter has no opinion on it and the
    // in-memory default carries one. Comparing it would refuse a correct pairing.
    test('maxKeys is not compared: it bounds a local table, it is not a limit', () => {
      const clock = frozenClock(0);
      expect(() =>
        defineAuth({
          adapter: new MemoryAdapter(),
          clock,
          limiter: shared(clock, { maxKeys: 7 }),
          rateLimit: { scope: 'shared', maxKeys: 90_000 },
        }),
      ).not.toThrow();
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

/**
 * The failure case first: `ipKey(ip)` builds its key from whatever address string the caller
 * handed `login({ ip })`, and that key was interpolated into `X_ACCOUNT_LOCKED`'s cause raw. A
 * newline in it writes a second log line an operator reads as genuine — the same log-forging
 * class `oauthDenied` already guarded, in a package that already knew the rule.
 */
describe('a hostile value cannot forge a line in the lockout refusal', () => {
  test('a newline in the key is escaped, not printed', async () => {
    const clock = frozenClock(0);
    const limiter = createAuthLimiter(clock, {
      ...DEFAULT_AUTH_RATE_LIMIT,
      maxAttempts: 1,
      lockoutMs: 60_000,
    });
    const forged = ipKey('203.0.113.7"\n2026-08-16 level=info msg="all clear');
    await limiter.recordFailure(forged);

    const thrown = await limiter.assertAllowed(forged).catch((error: unknown) => error);
    const error = thrown instanceof AuthError ? thrown : null;
    expect(error?.code).toBe('X_ACCOUNT_LOCKED');
    // Rendered as a JSON string literal, so the newline is two characters and the quote is
    // escaped: the refusal is still one line, and the value is still readable inside it.
    expect(error?.cause).not.toContain('\n');
    expect(error?.cause).toContain('\\n');
    expect(error?.cause).toContain('203.0.113.7');
    // The fix side was already closed; assert both halves here so neither can regress alone.
    expect(error?.fix).not.toContain('\n');
  });
});
