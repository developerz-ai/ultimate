// `maxAge` is the one bound in this package that decides about an IDENTITY, and both halves of the
// comparison it makes can arrive non-finite.
//
// `age > maxAge` is false when either side is `NaN`, and false here means RESTORED: a stored
// session that is a year old is handed back and the run acts as whoever it belonged to, with no
// re-login and nothing in the report. One side is configuration (`auth: { maxAge }`), the other is
// DATA — `savedAt` is a string in a bucket, and `parseSessionState` only checks that it is a
// string, so an edited or half-written record produces an `age` of `NaN` from a perfectly finite
// `maxAge`. A screen alone cannot reach the second, which is why the comparison fails closed.

import { describe, expect, test } from 'bun:test';
import { createLogger, isUltimateError, renderThrowable } from '@ultimat3/core';
import type { AuthPlanInput, ScrapeAuth } from './auth';
import { restorableSession } from './auth';
import { testClock } from './clock';
import { memorySessionStore, type SessionState } from './session-state';

const silent = createLogger({ writer: () => undefined });
const clock = testClock(new Date('2026-08-18T00:00:00.000Z'));

const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

const stored = (over: Partial<SessionState> = {}): SessionState => ({
  key: 'org-1/bank/default',
  savedAt: '2026-08-18T00:00:00.000Z',
  cookies: [
    { name: 'sid', value: 'x', domain: 'bank.test', path: '/', httpOnly: true, secure: true },
  ],
  headers: {},
  storage: {},
  userAgent: 'agent',
  origin: 'https://bank.test',
  ...over,
});

const planFor = <I>(auth: ScrapeAuth<I> | undefined): AuthPlanInput<I> => ({
  scrape: 'bank',
  auth,
  key: 'org-1/bank/default',
  clock,
  logger: silent,
});

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; cause: string }> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('a maxAge that is not a number was accepted');
}

describe('unit · session reuse, bounded', () => {
  for (const value of NOT_A_BOUND) {
    test(`a maxAge of ${String(value)} is refused, not read as "never expires"`, async () => {
      const store = memorySessionStore({
        'org-1/bank/default': stored({ savedAt: '2020-01-01T00:00:00.000Z' }),
      });
      const error = await refusal(() =>
        restorableSession(planFor({ login: () => Promise.resolve(), store, maxAge: value })),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('maxAge');
    });
  }

  // The other side of the comparison, which no screen on the option can reach: `savedAt` came out
  // of storage. A record whose timestamp is not a date must not be treated as fresh.
  test('a stored session whose savedAt is not a date is NOT restored', async () => {
    const store = memorySessionStore({
      'org-1/bank/default': stored({ savedAt: 'last tuesday' }),
    });
    const found = await restorableSession(
      planFor({ login: () => Promise.resolve(), store, maxAge: 86_400_000 }),
    );
    expect(found).toBeUndefined();
  });

  // `maxAge: 0` says "restore nothing stored before this instant", which is a coherent policy and
  // is what a caller means by it, so the floor is 0 and not 1. The boundary itself is unchanged:
  // the comparison has always been "older THAN", so an age equal to `maxAge` still restores.
  test('a maxAge of 0 is accepted, and expires anything stored earlier', async () => {
    const store = memorySessionStore({
      'org-1/bank/default': stored({ savedAt: '2026-08-17T23:59:59.000Z' }),
    });
    const found = await restorableSession(
      planFor({ login: () => Promise.resolve(), store, maxAge: 0 }),
    );
    expect(found).toBeUndefined();
  });

  test('a session inside a finite maxAge is still restored', async () => {
    const store = memorySessionStore({ 'org-1/bank/default': stored() });
    const found = await restorableSession(
      planFor({ login: () => Promise.resolve(), store, maxAge: 86_400_000 }),
    );
    expect(found?.cookies).toHaveLength(1);
  });
});
