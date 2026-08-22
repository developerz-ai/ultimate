// The shared limiter's PROTOCOL, driven through a recording executor: what it declares about
// itself, which statements a failure sends, and that every instant it writes comes from the
// injected clock. The SQL's own arithmetic is the `.live.` twin's job.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import {
  type AuthRateLimitPolicy,
  assertAuthLimiterPolicy,
  DEFAULT_AUTH_RATE_LIMIT,
} from './rate-limit';
import type { PgExecutor } from './rate-limit-postgres';
import {
  postgresAuthLimiter,
  SQL_AUTH_KEY_LOCK,
  SQL_AUTH_LIMIT_TABLES,
  SQL_AUTH_LOCK,
  SQL_AUTH_PURGE,
  SQL_AUTH_RECORD_FAILURE,
} from './rate-limit-postgres';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const clock = frozenClock(NOW);

const policy: AuthRateLimitPolicy = {
  maxAttempts: 5,
  windowMs: 60_000,
  lockoutMs: 300_000,
  maxKeys: 10_000,
  scope: 'shared',
};

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function executor(answers: readonly (readonly Record<string, unknown>[])[]): {
  readonly exec: PgExecutor;
  readonly calls: readonly Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const exec: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      const answer = answers[index] ?? [];
      index += 1;
      return Promise.resolve(answer as readonly R[]);
    },
  };
  return { exec, calls };
}

describe('the postgres auth limiter', () => {
  // The reason it exists: `assertAuthLimiterPolicy` refuses a per-process limiter under a
  // fleet-wide declaration, and until this store there was nothing an app could pass instead.
  test("declares itself shared, so a 'shared' lockout declaration can finally be satisfied", () => {
    const { exec } = executor([]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect(limiter.policy.scope).toBe('shared');
    expect(() => {
      assertAuthLimiterPolicy(policy, limiter);
    }).not.toThrow();
  });

  // `maxKeys` bounds ONE process' table; a limiter reporting a bound it does not enforce is the
  // thing the policy comparison exists to catch.
  test('reports no maxKeys, because it has no in-memory table to bound', () => {
    const { exec } = executor([]);
    expect(postgresAuthLimiter({ executor: exec, clock, policy }).policy.maxKeys).toBeUndefined();
  });

  test('the declared numbers travel unchanged, so defineAuth compares like with like', () => {
    const { exec } = executor([]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect(limiter.policy.maxAttempts).toBe(5);
    expect(limiter.policy.windowMs).toBe(60_000);
    expect(limiter.policy.lockoutMs).toBe(300_000);
    expect(() => {
      assertAuthLimiterPolicy({ ...DEFAULT_AUTH_RATE_LIMIT, scope: 'shared' }, limiter);
    }).toThrow();
  });

  // Two statements, not one: a CTE counting beside its own insert reads the statement's snapshot
  // and cannot see the row being written, so the lockout would fire one attempt late.
  test('a failure is recorded, then counted, in that order', async () => {
    const { exec, calls } = executor([[], []]);
    await postgresAuthLimiter({ executor: exec, clock, policy }).recordFailure('account:ada');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(SQL_AUTH_RECORD_FAILURE);
    expect(calls[0]?.params).toEqual(['account:ada', NOW.getTime()]);
    expect(calls[1]?.sql).toBe(SQL_AUTH_LOCK);
    expect(calls[1]?.params).toEqual(['account:ada', NOW.getTime(), 60_000, 300_000, 5]);
  });

  test('a live lockout is X_ACCOUNT_LOCKED, with the seconds left', async () => {
    const until = NOW.getTime() + 90_000;
    const { exec } = executor([[{ locked_until_ms: String(until) }]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    const failed = await limiter.assertAllowed('account:ada').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!isUltimateError(failed)) expect.unreachable('a locked account was let through');
    expect(failed.code).toBe('X_ACCOUNT_LOCKED');
    expect(failed.cause).toContain('90');
  });

  // The statement filters on the caller's clock, so an empty answer IS "not locked" — there is no
  // second comparison here to get wrong.
  test('no row back is not locked', async () => {
    const { exec, calls } = executor([[]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    await limiter.assertAllowed('account:ada');
    expect(await limiter.lockedUntil('account:ada')).toBeNull();
    expect(calls[0]?.params).toEqual(['account:ada', NOW.getTime()]);
  });

  // `PgExecutor` accepts a transaction handle, and the insert and the count are two statements —
  // so two OUTER transactions each counted committed rows plus their own, both read one short of
  // `maxAttempts`, and both committed. Three failures, no lockout. The insert therefore takes a
  // transaction-scoped advisory lock on the KEY, which is what makes the second transaction's
  // count run after the first has committed. `rate-limit-postgres.live.test.ts` runs the race.
  test('the failure insert serializes on the key before the row lands', () => {
    expect(SQL_AUTH_RECORD_FAILURE).toContain(SQL_AUTH_KEY_LOCK);
    // Locked BEFORE the insert, never after it: a lock taken afterwards leaves the window open.
    expect(SQL_AUTH_RECORD_FAILURE.indexOf(SQL_AUTH_KEY_LOCK)).toBeLessThan(
      SQL_AUTH_RECORD_FAILURE.indexOf('insert into x_auth_failures'),
    );
    // Transaction-scoped, never session-scoped: `pg_advisory_lock` outlives the statement and is
    // released when the CONNECTION goes back to the pool, which strands the lock on a pooled key.
    expect(SQL_AUTH_KEY_LOCK).toContain('pg_advisory_xact_lock');
    // Documented functions only — `hashtext` is an internal with no compatibility promise.
    expect(SQL_AUTH_KEY_LOCK).not.toContain('hashtext');
  });

  test('a bigint handed back as a string is still a Date', async () => {
    const until = NOW.getTime() + 1_000;
    const { exec } = executor([[{ locked_until_ms: String(until) }]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect((await limiter.lockedUntil('account:ada'))?.toISOString()).toBe(
      new Date(until).toISOString(),
    );
  });

  // Every instant in these tables is written from the caller's clock, so the purge must ask the
  // same one: measured against the server's, the offset between them deletes LIVE lockouts.
  test('the purge asks the injected clock, never the server', async () => {
    const { exec, calls } = executor([[{ removed: '7' }]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect(await limiter.purgeExpired()).toBe(7);
    expect(calls[0]?.sql).toBe(SQL_AUTH_PURGE);
    expect(calls[0]?.params).toEqual([NOW.getTime(), 60_000]);
    expect(SQL_AUTH_PURGE).not.toContain('now()');
  });

  test('the install statements are idempotent, because the boot runs them on every start', () => {
    expect(SQL_AUTH_LIMIT_TABLES).toContain('create table if not exists x_auth_failures');
    expect(SQL_AUTH_LIMIT_TABLES).toContain('create table if not exists x_auth_lockouts');
    expect(SQL_AUTH_LIMIT_TABLES.split('create index if not exists').length - 1).toBe(2);
  });

  // A row per failure is what makes the window SLIDE. A counter column would be a fixed window,
  // which admits `maxAttempts` twice across a boundary under the same declared numbers.
  test('failures are rows, never a counter', () => {
    expect(SQL_AUTH_LIMIT_TABLES).not.toContain('failures integer');
    expect(SQL_AUTH_RECORD_FAILURE).toContain('insert into x_auth_failures');
    expect(SQL_AUTH_LOCK).toContain('at_ms > $2::bigint - $3::bigint');
  });
});
