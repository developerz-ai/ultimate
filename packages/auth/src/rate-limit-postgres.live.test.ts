// The lockout's SQL, against a real server. The scripted-executor twin proves the protocol and
// can prove nothing about the statements: a limiter whose sliding-window count was never executed
// is a credential control nobody has run. The cases only a server can answer are the sliding
// window itself and two replicas counting one spray once.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// tables. Locally:
//
//   docker run -d --name x-auth -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/auth/src/rate-limit-postgres.live.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type AuthRateLimitPolicy, accountKey } from './rate-limit';
import type { PgExecutor, PostgresAuthLimiter } from './rate-limit-postgres';
import { postgresAuthLimiter, SQL_AUTH_LIMIT_TABLES } from './rate-limit-postgres';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const policy: AuthRateLimitPolicy = {
  maxAttempts: 3,
  windowMs: 60_000,
  lockoutMs: 300_000,
  scope: 'shared',
};

const START_MS = 1_700_000_000_000;

/** A clock this file moves by hand: a lockout test that sleeps is a lockout test that flakes. */
const clock = frozenClock(START_MS);
const atMs = (): number => clock.now().getTime();

/** How far behind the third replica's watch runs. */
const LAG_MS = 30_000;

/**
 * A real `Clock` — `monotonic` included — derived from the frozen one rather than an object
 * literal with only `now`. The literal typechecked nowhere `tsc -b` looks (this file is a test,
 * and tests are excluded from the project build), so it read as fine and was missing half the
 * interface; a cast would have hidden the same gap from the next reader.
 */
const laggingClock: Clock = {
  now: (): Date => new Date(atMs() - LAG_MS),
  monotonic: (): number => clock.monotonic() - LAG_MS,
};

let sql: Bun.SQL;
/** Two limiters over ONE table is the deployment being modelled: two replicas, one database. */
let podA: PostgresAuthLimiter;
let podB: PostgresAuthLimiter;
/** A third replica whose clock is half a minute behind — the case `greatest` exists for. */
let laggingPod: PostgresAuthLimiter;

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 4 });
  await sql.unsafe('drop table if exists x_auth_failures', []);
  await sql.unsafe('drop table if exists x_auth_lockouts', []);
  await sql.unsafe(SQL_AUTH_LIMIT_TABLES, []);
  const executor: PgExecutor = {
    query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      (await sql.unsafe(text, [...values])) as readonly R[],
  };
  podA = postgresAuthLimiter({ executor, clock, policy });
  podB = postgresAuthLimiter({ executor, clock, policy });
  laggingPod = postgresAuthLimiter({
    executor,
    clock: laggingClock,
    policy,
  });
});

afterAll(async () => {
  if (url === undefined) return;
  await sql.unsafe('drop table if exists x_auth_failures', []);
  await sql.unsafe('drop table if exists x_auth_lockouts', []);
  await sql.end();
});

beforeEach(async () => {
  if (url === undefined) return;
  clock.set(START_MS);
  await podA.reset();
});

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

describeLive('live · postgres · the shared auth limiter', () => {
  test('the failures one replica records lock the account on ANOTHER', async () => {
    const key = accountKey('ada@example.com');
    await podA.recordFailure(key);
    await podB.recordFailure(key);
    // Still inside the allowance: two of three.
    expect(await podA.lockedUntil(key)).toBeNull();

    await podA.recordFailure(key);
    // The whole point: pod B never counted three, and the fleet did.
    expect(await codeOf(podB.assertAllowed(key))).toBe('X_ACCOUNT_LOCKED');
    expect((await podB.lockedUntil(key))?.getTime()).toBe(atMs() + policy.lockoutMs);
  });

  // A fixed window would admit `maxAttempts` at the end of one window and `maxAttempts` again at
  // the start of the next. The window here SLIDES, which is why failures are rows and not a count.
  test('failures that fell out of the window do not add up to a lockout', async () => {
    const key = accountKey('grace@example.com');
    await podA.recordFailure(key);
    await podA.recordFailure(key);
    clock.advance(policy.windowMs + 1);
    await podA.recordFailure(key);
    expect(await podA.lockedUntil(key)).toBeNull();
  });

  test('a success clears the window on every replica, and a lockout with it', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.recordFailure(key);
    await podB.recordSuccess(key);
    expect(await podA.lockedUntil(key)).toBeNull();
    await podA.recordFailure(key);
    expect(await podA.lockedUntil(key)).toBeNull();
  });

  // A spray arriving during a lockout must not be able to shorten it.
  test('a later failure extends a live lockout and never moves it nearer', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.recordFailure(key);
    const first = (await podA.lockedUntil(key))?.getTime() ?? 0;
    clock.advance(1_000);
    await podB.recordFailure(key);
    const second = (await podA.lockedUntil(key))?.getTime() ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  // Two replicas do not share a clock, and the one that is behind must not be able to bring a
  // live lockout forward — that is a way to buy the account back by picking the right pod.
  test('a failure from a replica whose clock lags does not shorten the lockout', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.recordFailure(key);
    const first = (await podA.lockedUntil(key))?.getTime() ?? 0;
    await laggingPod.recordFailure(key);
    expect((await podA.lockedUntil(key))?.getTime()).toBe(first);
  });

  test('an expired lockout answers exactly as a missing one', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.recordFailure(key);
    clock.advance(policy.lockoutMs + 1);
    expect(await podA.lockedUntil(key)).toBeNull();
    expect(await codeOf(podA.assertAllowed(key))).toBe('did-not-throw');
  });

  test('purgeExpired drops stale failures and dead lockouts, and counts them', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.recordFailure(key);
    clock.advance(policy.lockoutMs + 1);
    expect(await podA.purgeExpired()).toBe(4);
    const failures = await sql.unsafe('select count(*)::int as n from x_auth_failures', []);
    expect((failures as { readonly n: number }[])[0]?.n).toBe(0);
  });

  // Concurrency: eight parallel failures against one key must not need a lucky interleaving to
  // lock. Each `recordFailure` counts AFTER its own insert committed, so nobody sees fewer.
  test('eight concurrent failures lock the key', async () => {
    const key = accountKey('parallel@example.com');
    await Promise.all(Array.from({ length: 8 }, () => podA.recordFailure(key)));
    expect(await codeOf(podB.assertAllowed(key))).toBe('X_ACCOUNT_LOCKED');
  });
});
