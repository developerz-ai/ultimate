// The limiter as a RESERVATION. The failure case first: `login` asked "is this key locked?", ran
// the KDF, and only then recorded the failure — so every guess of a concurrent burst passed the
// question before any of them had been counted, and `maxAttempts` bounded nothing but a
// sequential attacker.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { type AuthRateLimitPolicy, DEFAULT_AUTH_RATE_LIMIT, memoryAuthLimiter } from './rate-limit';

const KEY = 'account:ada@example.test';

const policy = (over: Partial<AuthRateLimitPolicy> = {}): AuthRateLimitPolicy => ({
  ...DEFAULT_AUTH_RATE_LIMIT,
  maxAttempts: 5,
  windowMs: 900_000,
  lockoutMs: 900_000,
  ...over,
});

const codeOf = (settled: PromiseSettledResult<unknown>): string =>
  settled.status === 'fulfilled'
    ? 'admitted'
    : settled.reason instanceof AuthError
      ? settled.reason.code
      : 'not-an-auth-error';

describe('reserve counts the attempt in the step that admits it', () => {
  test('a concurrent burst of 40 admits exactly maxAttempts', async () => {
    const limiter = memoryAuthLimiter(frozenClock(0), policy());
    const burst = await Promise.allSettled(Array.from({ length: 40 }, () => limiter.reserve(KEY)));
    const codes = burst.map(codeOf);
    expect(codes.filter((code) => code === 'admitted')).toHaveLength(5);
    expect(codes.filter((code) => code === 'X_ACCOUNT_LOCKED')).toHaveLength(35);
  });

  test('a refused reservation counts nothing and never moves the lockout', async () => {
    const clock = frozenClock(0);
    const limiter = memoryAuthLimiter(clock, policy({ lockoutMs: 60_000 }));
    for (let attempt = 0; attempt < 5; attempt += 1) await limiter.reserve(KEY);
    const until = await limiter.lockedUntil(KEY);

    clock.advance(30_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await limiter.reserve(KEY).catch(() => undefined);
    }
    // A spray arriving during a lockout neither extends it nor resets it to a nearer deadline.
    expect(await limiter.lockedUntil(KEY)).toEqual(until);
  });
});

describe('refund gives back one reservation and nothing more', () => {
  test('the attempt that filled the window, refunded, lifts the lockout it started', async () => {
    const limiter = memoryAuthLimiter(frozenClock(0), policy());
    for (let attempt = 0; attempt < 4; attempt += 1) await limiter.reserve(KEY);
    const fifth = await limiter.reserve(KEY);
    expect(await limiter.lockedUntil(KEY)).not.toBeNull();

    await limiter.refund(fifth);
    expect(await limiter.lockedUntil(KEY)).toBeNull();
    // Four failures are still counted: the very next one fills the window again.
    await limiter.reserve(KEY);
    expect(await limiter.lockedUntil(KEY)).not.toBeNull();
  });

  test('two reservations taken in one millisecond are refunded one at a time', async () => {
    const limiter = memoryAuthLimiter(frozenClock(0), policy({ maxAttempts: 3 }));
    const first = await limiter.reserve(KEY);
    await limiter.reserve(KEY);
    await limiter.refund(first);
    // One is still counted. Had the refund removed both, two more would not lock.
    await limiter.reserve(KEY);
    await limiter.reserve(KEY);
    expect(await limiter.lockedUntil(KEY)).not.toBeNull();
  });

  test('a refund for a key that was cleared, or never taken, changes nothing', async () => {
    const limiter = memoryAuthLimiter(frozenClock(0), policy());
    const taken = await limiter.reserve(KEY);
    await limiter.recordSuccess(KEY);
    await limiter.refund(taken);
    await limiter.refund({ key: 'account:nobody@example.test', atMs: 0 });
    expect(limiter.size).toBe(0);
  });

  test('a refund leaves a lockout the remaining failures still justify', async () => {
    const clock = frozenClock(0);
    const limiter = memoryAuthLimiter(clock, policy({ maxAttempts: 2 }));
    const early = await limiter.reserve(KEY);
    clock.advance(10);
    await limiter.reserve(KEY);
    clock.advance(10);
    // The lock has expired by neither clock; a third reservation is refused, so only the first
    // two exist — refunding one of two leaves one, below the cap, and the lock lifts.
    await limiter.refund(early);
    expect(await limiter.lockedUntil(KEY)).toBeNull();
    // And with the window full again, a refund of something not in it does not lift the lock.
    await limiter.reserve(KEY);
    await limiter.refund(early);
    expect(await limiter.lockedUntil(KEY)).not.toBeNull();
  });
});
