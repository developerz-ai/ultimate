// The shared limiter's PROTOCOL, driven through a recording executor: what it declares about
// itself, which statement a reservation sends, and that every instant it writes comes from the
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
  SQL_AUTH_LIMIT_TABLES,
  SQL_AUTH_PURGE,
  SQL_AUTH_REFUND,
  SQL_AUTH_TAKE,
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

  const codeOf = async (call: Promise<unknown>): Promise<string> =>
    await call.then(
      () => 'did-not-throw',
      (reason: unknown) => (isUltimateError(reason) ? reason.code : 'not-an-UltimateError'),
    );

  // ONE statement: the decision and the count cannot be told apart by a concurrent caller.
  test('a reservation is one statement, and it answers the instant it took', async () => {
    const { exec, calls } = executor([[{ admitted: true, locked_until_ms: '0' }]]);
    const taken = await postgresAuthLimiter({ executor: exec, clock, policy }).reserve(
      'account:ada',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(SQL_AUTH_TAKE);
    expect(calls[0]?.params).toEqual(['account:ada', NOW.getTime(), 60_000, 300_000, 5]);
    expect(taken).toEqual({ key: 'account:ada', atMs: NOW.getTime() });
  });

  test('a refused reservation is X_ACCOUNT_LOCKED, with the seconds left', async () => {
    const until = NOW.getTime() + 90_000;
    const { exec } = executor([[{ admitted: false, locked_until_ms: String(until) }]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    const failed = await limiter.reserve('account:ada').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!isUltimateError(failed)) expect.unreachable('a locked account was let through');
    expect(failed.code).toBe('X_ACCOUNT_LOCKED');
    expect(failed.cause).toContain('90');
  });

  // Fail closed: an executor that answered nothing, or a row with no verdict in it, is not an
  // admission. Read the other way, a broken store is an open door on the credential path.
  test.each([
    ['no row', []],
    ['a row with no verdict', [{ locked_until_ms: '0' }]],
    ['a verdict that is not the boolean', [{ admitted: 't', locked_until_ms: '0' }]],
  ])('%s is never read as admitted', async (_, answer) => {
    const { exec } = executor([answer]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect(await codeOf(limiter.reserve('account:ada'))).not.toBe('did-not-throw');
  });

  test('a refund names the reservation, and asks the injected clock for the window', async () => {
    const { exec, calls } = executor([[]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    await limiter.refund({ key: 'ip:203.0.113.7', atMs: 41 });
    expect(calls[0]?.sql).toBe(SQL_AUTH_REFUND);
    expect(calls[0]?.params).toEqual(['ip:203.0.113.7', 41, NOW.getTime(), 60_000, 5]);
  });

  // The statement filters on the caller's clock, so an empty answer IS "not locked" — there is no
  // second comparison here to get wrong.
  test('no row back is not locked', async () => {
    const { exec, calls } = executor([[]]);
    const limiter = postgresAuthLimiter({ executor: exec, clock, policy });
    expect(await limiter.lockedUntil('account:ada')).toBeNull();
    expect(calls[0]?.params).toEqual(['account:ada', NOW.getTime()]);
  });

  // A count over a second table reads the statement's snapshot, which predates any wait: the
  // window has to be read off the row the take itself locks, or two concurrent takes each count
  // one short. `rate-limit-postgres.live.test.ts` runs the race.
  test('the take reads the window off the row it locks, never from a CTE', () => {
    expect(SQL_AUTH_TAKE).toContain('on conflict (key) do update');
    expect(SQL_AUTH_TAKE).toContain('unnest(x_auth_lockouts.attempts_ms)');
    expect(SQL_AUTH_TAKE.trimStart().startsWith('insert into x_auth_lockouts')).toBe(true);
    expect(SQL_AUTH_TAKE).not.toContain('with ');
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
    expect(SQL_AUTH_LIMIT_TABLES).toContain('create table if not exists x_auth_lockouts');
    expect(SQL_AUTH_LIMIT_TABLES.split('create table').length - 1).toBe(1);
    expect(SQL_AUTH_LIMIT_TABLES.split('create index if not exists').length - 1).toBe(1);
  });

  // A table made by the previous release has neither column. Both arrive additively, with a
  // default, so the replica still running that release goes on reading and writing its two.
  test('a table from before the reservation is upgraded in place, additively', () => {
    const upgrades = SQL_AUTH_LIMIT_TABLES.split(';').filter((line) => line.includes('alter '));
    expect(upgrades).toHaveLength(2);
    for (const upgrade of upgrades) {
      expect(upgrade).toContain('add column if not exists');
      expect(upgrade).toContain('not null default');
    }
    expect(SQL_AUTH_LIMIT_TABLES).not.toContain('drop ');
  });

  // The instants are what make the window SLIDE. A counter column would be a fixed window, which
  // admits `maxAttempts` twice across a boundary under the same declared numbers.
  test('attempts are instants, never a counter', () => {
    expect(SQL_AUTH_LIMIT_TABLES).toContain('attempts_ms     bigint[] not null');
    expect(SQL_AUTH_TAKE).toContain('at_ms > $2::bigint - $3::bigint');
  });
});
