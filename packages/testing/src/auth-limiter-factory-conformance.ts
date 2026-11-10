// The `AuthLimiterFactory` contract of `@ultimat3/auth` as shared examples: `behavesLike(
// authLimiterFactoryConformance, () => ({ factory, clock }))`. Time is the frozen clock the limiters
// read, never a sleep. Every limiter RESERVES: an attempt counts in the step that admits it, so a
// concurrent burst spends the allowance before any guess reaches the KDF.

import { expect, test } from 'bun:test';
import type { AuthLimiter, AuthLimiterFactory, AuthRateLimitPolicy } from '@ultimat3/auth/adapter';
import type { FrozenClock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

/** The factory under test, and the clock every limiter it builds reads. */
export interface AuthLimiterSubject {
  readonly factory: AuthLimiterFactory;
  readonly clock: FrozenClock;
}

export interface AuthLimiterCheck {
  readonly name: string;
  run(subject: AuthLimiterSubject): Promise<void>;
}

const POLICY: AuthRateLimitPolicy = {
  maxAttempts: 3,
  windowMs: 60_000,
  lockoutMs: 300_000,
  scope: 'process',
};
const BURST = 20;

/** A key no other check, run or process shares — a shared table holds every run's keys. */
const keyOf = (label: string): string => `account:conformance-${label}-${crypto.randomUUID()}`;

/** The code a call refused with, or `admitted`. */
const outcome = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-UltimateError';
  }
  return 'admitted';
};

const reserveTimes = async (limiter: AuthLimiter, key: string, n: number): Promise<void> => {
  for (let index = 0; index < n; index += 1) await limiter.reserve(key);
};

const build = ({ factory }: AuthLimiterSubject): AuthLimiter => factory(POLICY);

export const AUTH_LIMITER_CHECKS: readonly AuthLimiterCheck[] = [
  {
    name: 'reports the limits it was built with, and where it counts',
    async run(subject) {
      const { policy } = build(subject);
      expect([policy.maxAttempts, policy.windowMs, policy.lockoutMs]).toEqual([3, 60_000, 300_000]);
      expect(['process', 'shared']).toContain(policy.scope);
    },
  },
  {
    name: 'the attempt that fills the window is admitted and starts the lockout; the next is refused',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('fill');
      await reserveTimes(limiter, key, 2);
      expect(await limiter.lockedUntil(key)).toBeNull();
      expect(await outcome(limiter.reserve(key))).toBe('admitted');
      const until = subject.clock.now().getTime() + POLICY.lockoutMs;
      expect((await limiter.lockedUntil(key))?.getTime()).toBe(until);
      expect(await outcome(limiter.reserve(key))).toBe('X_ACCOUNT_LOCKED');
    },
  },
  {
    name: 'attempts that slid out of the window do not add up to a lockout',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('slide');
      await reserveTimes(limiter, key, 2);
      subject.clock.advance(POLICY.windowMs + 1);
      await limiter.reserve(key);
      expect(await limiter.lockedUntil(key)).toBeNull();
    },
  },
  {
    name: 'recordSuccess clears the window and a lockout with it',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('success');
      await reserveTimes(limiter, key, 3);
      await limiter.recordSuccess(key);
      expect(await limiter.lockedUntil(key)).toBeNull();
      await reserveTimes(limiter, key, 2);
      expect(await limiter.lockedUntil(key)).toBeNull();
    },
  },
  {
    name: 'a refused reservation counts nothing and never moves a live lockout',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('refused');
      await reserveTimes(limiter, key, 3);
      const first = (await limiter.lockedUntil(key))?.getTime();
      subject.clock.advance(1_000);
      expect(await outcome(limiter.reserve(key))).toBe('X_ACCOUNT_LOCKED');
      expect((await limiter.lockedUntil(key))?.getTime()).toBe(first);
    },
  },
  {
    name: 'an expired lockout answers exactly as a missing one',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('expired');
      await reserveTimes(limiter, key, 3);
      subject.clock.advance(POLICY.lockoutMs + 1);
      expect(await limiter.lockedUntil(key)).toBeNull();
      expect(await outcome(limiter.reserve(key))).toBe('admitted');
      expect(await limiter.lockedUntil(key)).toBeNull();
    },
  },
  {
    name: 'a refund gives one attempt back and lifts the lockout that attempt started',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('refund');
      await reserveTimes(limiter, key, 2);
      const third = await limiter.reserve(key);
      expect(await limiter.lockedUntil(key)).not.toBeNull();
      await limiter.refund(third);
      expect(await limiter.lockedUntil(key)).toBeNull();
      // Two are still counted: the next one fills the window again.
      await limiter.reserve(key);
      expect(await limiter.lockedUntil(key)).not.toBeNull();
    },
  },
  {
    name: 'reservations at one instant are refunded one at a time',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('same-ms');
      const first = await limiter.reserve(key);
      await limiter.reserve(key);
      await limiter.refund(first);
      // A reservation this limiter never handed out gives nothing back.
      await limiter.refund({ key, atMs: first.atMs - 1 });
      await limiter.reserve(key);
      expect(await limiter.lockedUntil(key)).toBeNull();
      await limiter.reserve(key);
      expect(await limiter.lockedUntil(key)).not.toBeNull();
    },
  },
  {
    name: `a concurrent burst of ${BURST} is admitted maxAttempts times`,
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('burst');
      const codes = await Promise.all(
        Array.from({ length: BURST }, () => outcome(limiter.reserve(key))),
      );
      expect(codes.filter((code) => code === 'admitted')).toHaveLength(POLICY.maxAttempts);
      expect(codes.filter((code) => code === 'X_ACCOUNT_LOCKED')).toHaveLength(
        BURST - POLICY.maxAttempts,
      );
    },
  },
  {
    name: 'two limiters from one factory count one key together',
    async run(subject) {
      const [podA, podB] = [build(subject), build(subject)];
      const key = keyOf('fleet');
      await podA.reserve(key);
      await podB.reserve(key);
      await podA.reserve(key);
      // A per-process limiter keeps its own count and is honest about it.
      const shared = podB.policy.scope === 'shared';
      expect(await outcome(podB.reserve(key))).toBe(shared ? 'X_ACCOUNT_LOCKED' : 'admitted');
    },
  },
  {
    name: 'one key locked is no other key locked',
    async run(subject) {
      const limiter = build(subject);
      const [locked, other] = [keyOf('locked'), keyOf('other')];
      await reserveTimes(limiter, locked, 3);
      expect(await limiter.lockedUntil(other)).toBeNull();
      expect(await outcome(limiter.reserve(other))).toBe('admitted');
    },
  },
  {
    name: 'reset forgets every key',
    async run(subject) {
      const limiter = build(subject);
      const key = keyOf('reset');
      await reserveTimes(limiter, key, 3);
      await limiter.reset();
      expect(await limiter.lockedUntil(key)).toBeNull();
      await reserveTimes(limiter, key, 2);
      expect(await limiter.lockedUntil(key)).toBeNull();
    },
  },
  {
    name: 'purgeExpired, when declared, keeps a live lockout and drops a dead one',
    async run(subject) {
      const limiter = build(subject);
      if (limiter.purgeExpired === undefined) return;
      const key = keyOf('purge');
      await reserveTimes(limiter, key, 3);
      await limiter.purgeExpired();
      expect(await limiter.lockedUntil(key)).not.toBeNull();
      subject.clock.advance(POLICY.lockoutMs + 1);
      expect(await limiter.purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await outcome(limiter.reserve(key))).toBe('admitted');
    },
  },
];

export const authLimiterFactoryConformance: SharedExamples<
  AuthLimiterSubject | Promise<AuthLimiterSubject>
> = sharedExamples('an auth limiter factory', (subject) => {
  for (const check of AUTH_LIMITER_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
