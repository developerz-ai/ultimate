// The conformance suite over the memory limiter, and the proof it can fail: a limiter that checks,
// then counts after a turn (forty guesses all passed the check), and a refund that clears the key.

import { describe, expect, test } from 'bun:test';
import { memoryAuthLimiter } from '@ultimat3/auth';
import type { AuthLimiter, AuthLimiterFactory } from '@ultimat3/auth/adapter';
import { frozenClock } from '@ultimat3/core';
import type { AuthLimiterSubject } from './auth-limiter-factory-conformance';
import {
  AUTH_LIMITER_CHECKS,
  authLimiterFactoryConformance,
} from './auth-limiter-factory-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const START_MS = 1_700_000_000_000;

const subjectOf = (wrap: (limiter: AuthLimiter) => AuthLimiter): AuthLimiterSubject => {
  const clock = frozenClock(START_MS);
  const factory: AuthLimiterFactory = (policy) => wrap(memoryAuthLimiter(clock, policy));
  return { factory, clock };
};
const memory = (): AuthLimiterSubject => subjectOf((limiter) => limiter);

describe(testName('unit', 'the memory auth limiter'), () => {
  behavesLike(authLimiterFactoryConformance, memory);
});

/** "Locked?" first, the count a turn later: every concurrent guess passes the check. */
const checkThenCount = (inner: AuthLimiter): AuthLimiter => ({
  ...inner,
  policy: inner.policy,
  reserve: async (key) => {
    if ((await inner.lockedUntil(key)) !== null) return inner.reserve(key);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const admitted = { key, atMs: Date.now() };
    await inner.reserve(key).catch(() => undefined);
    return admitted;
  },
});

/** A refund that forgets the whole key — one success-less retry wipes the spray's count. */
const refundClears = (inner: AuthLimiter): AuthLimiter => ({
  ...inner,
  policy: inner.policy,
  refund: (reservation) => inner.recordSuccess(reservation.key),
});

const check = (name: string) => {
  const found = AUTH_LIMITER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a limiter that breaks the contract fails conformance'), () => {
  test('a reserve that checks, then counts', async () => {
    const burst = check('a concurrent burst');
    await expect(burst.run(subjectOf(checkThenCount))).rejects.toThrow();
    await burst.run(memory());
  });

  test('a refund that clears the key', async () => {
    const refund = check('a refund gives one attempt back');
    await expect(refund.run(subjectOf(refundClears))).rejects.toThrow();
    await refund.run(memory());
  });

  test('every check has a name of its own', () => {
    const names = AUTH_LIMITER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
