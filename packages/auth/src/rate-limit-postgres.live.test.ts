// The lockout's SQL, against a real server, for what only this table can show: an upgrade from the
// previous release's table, a replica whose clock lags, rows left behind, and two OPEN transactions
// counting one account. The limiter's own contract — reservation, sliding window, refund, the
// burst — is `@ultimat3/testing`'s `authLimiterFactoryConformance`, run over this limiter in
// `packages/testing/src/auth-limiter-factory-conformance-postgres.live.test.ts`.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// tables. Locally:
//
//   docker run -d --name x-auth -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/auth/src/rate-limit-postgres.live.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, PgExecutor } from '@ultimat3/core';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type AuthRateLimitPolicy, accountKey } from './rate-limit';
import type { PostgresAuthLimiter } from './rate-limit-postgres';
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

/** A lockout written by the previous release's two-column table, before the upgrade ran. */
const CARRIED_KEY = 'account:carried@example.com';
let carriedCode = 'never-ran';

/**
 * The one-line wrapping every host does, over the pool OR over a transaction handle — `PgExecutor`
 * accepts both, which is why the take has to serialise on the key's own row.
 */
const executorOn = (client: Bun.SQL): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    (await client.unsafe(text, [...values])) as readonly R[],
});

/** Two limiters over ONE table is the deployment being modelled: two replicas, one database. */
let podA: PostgresAuthLimiter;
let podB: PostgresAuthLimiter;
/** A third replica whose clock is half a minute behind: it must not move a live lockout. */
let laggingPod: PostgresAuthLimiter;

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 6 });
  await sql.unsafe('drop table if exists x_auth_lockouts', []);
  // The table as the previous release made it, with a lockout that release established: the
  // install below has to upgrade it in place and the take has to honour what it holds.
  await sql.unsafe(
    'create table x_auth_lockouts (key text primary key, locked_until_ms bigint not null)',
    [],
  );
  await sql.unsafe('insert into x_auth_lockouts (key, locked_until_ms) values ($1, $2)', [
    CARRIED_KEY,
    START_MS + 60_000,
  ]);
  await sql.unsafe(SQL_AUTH_LIMIT_TABLES, []);
  await sql.unsafe(SQL_AUTH_LIMIT_TABLES, []);
  carriedCode = await codeOf(
    postgresAuthLimiter({ executor: executorOn(sql), clock, policy }).reserve(CARRIED_KEY),
  );
  podA = postgresAuthLimiter({ executor: executorOn(sql), clock, policy });
  podB = postgresAuthLimiter({ executor: executorOn(sql), clock, policy });
  laggingPod = postgresAuthLimiter({
    executor: executorOn(sql),
    clock: laggingClock,
    policy,
  });
});

afterAll(async () => {
  if (url === undefined) return;
  await sql.unsafe('drop table if exists x_auth_lockouts', []);
  await sql.end();
});

beforeEach(async () => {
  if (url === undefined) return;
  clock.set(START_MS);
  await podA.reset();
});

/**
 * Two numbers, and the ORDER between them is the point: the wait must give up well inside the
 * test's own budget, or a missing lock is reported as "timed out after 5000ms" — which reads as a
 * flaky runner — instead of as the sentence naming what did not happen.
 */
const LOCK_WAIT_DEADLINE_MS = 2_000;
const RACE_TIMEOUT_MS = 20_000;

/**
 * Answer whether Postgres itself reports a session parked on an ungranted lock, waiting
 * for the CONDITION rather than for a duration. `pg_locks` is the server's own answer to "is
 * anything waiting?", so the interleaving is observed instead of assumed — a fixed sleep would
 * flake on a slow runner rather than fail on a real regression.
 */
const rowLockHasWaiter = async (): Promise<boolean> => {
  const deadline = Bun.nanoseconds() + LOCK_WAIT_DEADLINE_MS * 1_000_000;
  while (Bun.nanoseconds() < deadline) {
    const rows = (await sql.unsafe(
      'select count(*)::int as n from pg_locks where not granted',
      [],
    )) as { readonly n: number }[];
    if ((rows[0]?.n ?? 0) > 0) return true;
    await Bun.sleep(10);
  }
  return false;
};

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

const rowCount = async (): Promise<number> => {
  const rows = await sql.unsafe('select count(*)::int as n from x_auth_lockouts', []);
  return (rows as { readonly n: number }[])[0]?.n ?? -1;
};

describeLive('live · postgres · the shared auth limiter', () => {
  test('a table and a lockout from the previous release survive the upgrade', () => {
    expect(carriedCode).toBe('X_ACCOUNT_LOCKED');
  });

  // A spray arriving during a lockout is refused, counts nothing, and cannot move the deadline —
  // not from this replica and not from one whose clock runs behind.
  test('a refused reservation never moves a live lockout, from any replica', async () => {
    const key = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.reserve(key);
    const first = (await podA.lockedUntil(key))?.getTime() ?? 0;
    clock.advance(1_000);
    expect(await codeOf(podB.reserve(key))).toBe('X_ACCOUNT_LOCKED');
    expect(await codeOf(laggingPod.reserve(key))).toBe('X_ACCOUNT_LOCKED');
    expect((await podA.lockedUntil(key))?.getTime()).toBe(first);
  });

  test('a refund for a key that is gone writes nothing', async () => {
    await podA.refund({ key: accountKey('nobody@example.com'), atMs: atMs() });
    expect(await rowCount()).toBe(0);
  });

  test('purgeExpired drops keys with nothing live, keeps the rest, and counts what went', async () => {
    const dead = accountKey('ada@example.com');
    for (let i = 0; i < 3; i += 1) await podA.reserve(dead);
    clock.advance(policy.lockoutMs - 1);
    // Window long emptied, lockout one millisecond from over: still held.
    expect(await podA.purgeExpired()).toBe(0);
    clock.advance(2);
    const fresh = accountKey('grace@example.com');
    await podA.reserve(fresh);
    expect(await podA.purgeExpired()).toBe(1);
    expect(await rowCount()).toBe(1);
  });

  // The case only a TRANSACTION can produce. Two open transactions each see what has COMMITTED
  // plus their own write, so with two attempts committed both would count three against
  // `maxAttempts: 3` and BOTH be admitted — four attempts. The take serialises on the key's row:
  // the second waits for the first to commit and is then judged against what it wrote.
  test(
    'reservations from two OPEN transactions are admitted one at a time',
    async () => {
      const key = accountKey('interleaved@example.com');
      await podA.reserve(key);
      await podA.reserve(key);

      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHasReserved!: () => void;
      const firstReserved = new Promise<void>((resolve) => {
        firstHasReserved = resolve;
      });

      const first = sql.begin(async (tx: Bun.SQL) => {
        await postgresAuthLimiter({ executor: executorOn(tx), clock, policy }).reserve(key);
        firstHasReserved();
        await firstMayCommit;
      });

      let waited = false;
      let secondCode = 'never-ran';
      try {
        await firstReserved;
        // Opened while the first transaction is still uncommitted, which is the whole case.
        const second = sql.begin(async (tx: Bun.SQL) => {
          secondCode = await codeOf(
            postgresAuthLimiter({ executor: executorOn(tx), clock, policy }).reserve(key),
          );
        });
        waited = await rowLockHasWaiter();
        releaseFirst();
        await Promise.all([first, second]);
      } finally {
        // The open transaction is released whatever happened above, or every later case in this
        // file inherits a wedged connection and reports a hook timeout instead of its own verdict.
        releaseFirst();
        await first.catch(() => undefined);
      }

      expect(waited).toBe(true);
      // The first filled the window and started the lockout; the second saw that, not a stale two.
      expect(secondCode).toBe('X_ACCOUNT_LOCKED');
    },
    RACE_TIMEOUT_MS,
  );
});
