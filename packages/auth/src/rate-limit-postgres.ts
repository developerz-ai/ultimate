// The shared credential limiter: two Postgres tables, so N replicas count one spray once and a
// lockout one pod established is visible to the rest. Without it `rateLimit.scope: 'shared'` is a
// declaration nothing can satisfy, while `x new` scaffolds `replicas: 2` — which is
// `maxAttempts × 2` guesses per account.
import type { Clock } from '@ultimat3/core';
import { accountLocked } from './errors';
import type { AuthLimiter, AuthRateLimitPolicy } from './rate-limit';

/**
 * The one thing this limiter needs from the DB layer, declared structurally rather than imported.
 * `@ultimat3/action`'s `idempotency-postgres.ts` and `@ultimat3/http`'s rate-limit store declare
 * the same shape for the same reason: the connection belongs to the HOST, not to any of them, so
 * a limiter takes the pool the boot already opened instead of opening a second one against a URL
 * that was resolved once.
 *
 * **`Bun.sql` does not satisfy it** — `Bun.sql.query` is `undefined`; it is a tagged template
 * whose positional form is `unsafe`. `@ultimat3/db`'s `DbClient.query({ text, values })` does,
 * wrapped in one line, and so does a transaction handle.
 */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}

/**
 * Applied by the boot, never by an app migration — the rule `SQL_IDEMPOTENCY_TABLE` follows, so
 * `x dev`, the container's `web` role and `ROLE=migrate` all install it.
 *
 * A row per FAILURE rather than a counter per key, because the window this package enforces is a
 * SLIDING one: a counter plus a window end is a fixed window, which admits `maxAttempts` at the
 * end of one window and `maxAttempts` again at the start of the next — twice the declared
 * allowance, under the same declared numbers, on the credential path.
 */
export const SQL_AUTH_LIMIT_TABLES = `
create table if not exists x_auth_failures (
  key   text   not null,
  at_ms bigint not null
);

create index if not exists x_auth_failures_key_idx on x_auth_failures (key, at_ms);

create table if not exists x_auth_lockouts (
  key             text   primary key,
  locked_until_ms bigint not null
);

create index if not exists x_auth_lockouts_until_idx on x_auth_lockouts (locked_until_ms);
`;

/**
 * The per-key serializer, spelled from documented functions only: `md5` and a hex bit-string cast,
 * never `hashtext`, which is an internal with no compatibility promise.
 */
export const SQL_AUTH_KEY_LOCK = "pg_advisory_xact_lock(('x' || md5($1))::bit(64)::bigint)";

/**
 * `$1` key, `$2` nowMs — and a **transaction-scoped advisory lock on the key**, taken in the same
 * statement, before the row lands.
 *
 * `PgExecutor` accepts a transaction handle (see its doc comment), and the insert and the count
 * below are two statements. Without this lock two OUTER transactions recording a failure for one
 * account each counted only what had COMMITTED plus their own row: with `maxAttempts: 3` and one
 * failure already committed, both read two, neither locked, and both committed — three failures
 * and an open account. The lock makes the second transaction wait at the insert until the first
 * commits, so its count is taken against a snapshot that already holds the first's row.
 *
 * Autocommit is unaffected: the lock is taken and released inside the statement's own implicit
 * transaction, which is one extra no-op per failure and no extra round trip. The guarantee is
 * READ COMMITTED, which is what `withTransaction` opens with no `isolation:` — a caller that opts
 * into `'repeatable read'` or `'serializable'` pins the count's snapshot at transaction start, and
 * no lock can make a statement see a commit its own snapshot precedes.
 *
 * `recordFailure` always locks account → ip → org (`auth.ts`), one fixed order, so two concurrent
 * sign-ins cannot take two of these locks in opposite orders and deadlock.
 */
export const SQL_AUTH_RECORD_FAILURE = `
with locked as (select ${SQL_AUTH_KEY_LOCK})
insert into x_auth_failures (key, at_ms)
select $1, $2::bigint from locked
`;

/**
 * `$1` key, `$2` nowMs, `$3` windowMs, `$4` lockoutMs, `$5` maxAttempts.
 *
 * A SECOND statement, deliberately, and not a CTE beside the insert above: every CTE in one
 * statement reads that statement's snapshot, so a `count(*)` sharing it cannot see the failure
 * being inserted beside it and the lock would fire one attempt late. Run afterwards, the count
 * sees this caller's own row and every other replica's that has committed — and, because the
 * insert holds `SQL_AUTH_KEY_LOCK`, every row a concurrent transaction on this key committed too.
 *
 * `greatest` on conflict EXTENDS a live lockout and never shortens one — a spray arriving during
 * a lockout must not be able to reset it to a nearer deadline.
 */
export const SQL_AUTH_LOCK = `
insert into x_auth_lockouts (key, locked_until_ms)
select $1, $2::bigint + $4::bigint
  from x_auth_failures
 where key = $1 and at_ms > $2::bigint - $3::bigint
having count(*) >= $5::bigint
on conflict (key) do update
   set locked_until_ms = greatest(x_auth_lockouts.locked_until_ms, excluded.locked_until_ms)
returning locked_until_ms
`;

/** `$2` is the caller's clock: an expired lockout answers exactly as a missing one. */
export const SQL_AUTH_LOCKED_UNTIL = `
select locked_until_ms from x_auth_lockouts where key = $1 and locked_until_ms > $2::bigint
`;

/** A success clears the window AND the lockout: one round trip, because both must go together. */
export const SQL_AUTH_FORGET_KEY = `
with cleared as (delete from x_auth_failures where key = $1 returning key)
delete from x_auth_lockouts where key = $1
`;

export const SQL_AUTH_RESET = `
with cleared as (delete from x_auth_failures returning key)
delete from x_auth_lockouts
`;

/**
 * `$1` nowMs, `$2` windowMs — the CALLER's clock, never `now()`. Every instant in these tables is
 * written from the caller's clock, so a purge measuring against the SERVER's would delete rows by
 * the offset between the two: failures that are still inside the window, and lockouts that are
 * still live. The second one hands a sprayer its account back.
 */
export const SQL_AUTH_PURGE = `
with dropped_failures as (
  delete from x_auth_failures where at_ms <= $1::bigint - $2::bigint returning key
), dropped_lockouts as (
  delete from x_auth_lockouts where locked_until_ms <= $1::bigint returning key
)
select (select count(*) from dropped_failures) + (select count(*) from dropped_lockouts) as removed
`;

export interface PostgresAuthLimiterOptions {
  readonly executor: PgExecutor;
  /** No `Date.now()` in this package: every instant written and compared comes from here. */
  readonly clock: Clock;
  /**
   * The limits to enforce. `defineAuth` compares what this limiter REPORTS against what the app
   * declared, so the two must be the same object — `postgresAuthLimiter({ policy: auth.rateLimit })`
   * for the account and IP buckets, and `orgRateLimit(policy)` for the tenant one.
   */
  readonly policy: AuthRateLimitPolicy;
}

export interface PostgresAuthLimiter extends AuthLimiter {
  /**
   * Drop every failure past the window and every expired lockout, and answer how many rows went.
   * Neither table bounds itself — `ipKey` mints one key per source address, so a spray from an
   * IPv6 /64 is a row per attempt — and Postgres forgets nothing on its own. An app runs this
   * from a `task`; a row this deletes answers exactly as a missing one, so it changes no decision.
   */
  purgeExpired(): Promise<number>;
}

interface LockRow {
  /** `bigint`, which every Postgres client hands back as a string. */
  readonly locked_until_ms: number | string;
}

/**
 * **Install it at `defineAuth`, beside the declaration it satisfies.** Two limiters, one table:
 * the keys are prefixed (`account:`, `ip:`, `org:`) and every limit travels as a parameter, so
 * the tenant bucket's wider allowance cannot leak into the account bucket's.
 *
 * ```ts
 * const client = db();
 * const executor = { query: (text, values) => client.query({ text, values }) };
 * const rateLimit = { ...DEFAULT_AUTH_RATE_LIMIT, scope: 'shared' } as const;
 * defineAuth({
 *   rateLimit,
 *   limiter: postgresAuthLimiter({ executor, clock, policy: rateLimit }),
 *   orgLimiter: postgresAuthLimiter({ executor, clock, policy: orgRateLimit(rateLimit) }),
 * });
 * ```
 */
export function postgresAuthLimiter(options: PostgresAuthLimiterOptions): PostgresAuthLimiter {
  const exec = options.executor;
  const clock = options.clock;
  const policy = options.policy;
  const nowMs = (): number => clock.now().getTime();

  const lockedUntilMs = async (key: string): Promise<number | null> => {
    const rows = await exec.query<LockRow>(SQL_AUTH_LOCKED_UNTIL, [key, nowMs()]);
    const row = rows[0];
    return row === undefined ? null : Number(row.locked_until_ms);
  };

  return {
    // `maxKeys` is dropped, not passed through: it bounds ONE process' table, and reporting a
    // bound this limiter does not enforce is the thing `assertAuthLimiterPolicy` exists to catch.
    policy: { ...policy, maxKeys: undefined, scope: 'shared' },

    async assertAllowed(key): Promise<void> {
      const until = await lockedUntilMs(key);
      if (until === null) return;
      throw accountLocked(key, Math.ceil((until - nowMs()) / 1000));
    },

    async recordFailure(key): Promise<void> {
      const at = nowMs();
      await exec.query(SQL_AUTH_RECORD_FAILURE, [key, at]);
      await exec.query(SQL_AUTH_LOCK, [
        key,
        at,
        policy.windowMs,
        policy.lockoutMs,
        policy.maxAttempts,
      ]);
    },

    async recordSuccess(key): Promise<void> {
      await exec.query(SQL_AUTH_FORGET_KEY, [key]);
    },

    async lockedUntil(key): Promise<Date | null> {
      const until = await lockedUntilMs(key);
      return until === null ? null : new Date(until);
    },

    async reset(): Promise<void> {
      await exec.query(SQL_AUTH_RESET, []);
    },

    async purgeExpired(): Promise<number> {
      const rows = await exec.query<{ readonly removed: number | string }>(SQL_AUTH_PURGE, [
        nowMs(),
        policy.windowMs,
      ]);
      return Number(rows[0]?.removed ?? 0);
    },
  };
}
