// The shared credential limiter: one Postgres table, so N replicas count one spray once and a
// lockout one pod established is visible to the rest. Without it `rateLimit.scope: 'shared'` is a
// declaration nothing can satisfy, while `x new` scaffolds `replicas: 2` — which is
// `maxAttempts × 2` guesses per account.
import type { Clock, PgExecutor } from '@ultimat3/core';
import { accountLocked, authWriteFailed } from './errors';
import type { AuthLimiter, AuthRateLimitPolicy, AuthReservation } from './rate-limit';

/**
 * Applied by the boot, never by an app migration — the rule `SQL_IDEMPOTENCY_TABLE` follows, so
 * `x dev`, the container's `web` role and `ROLE=migrate` all install it.
 *
 * ONE row per key, holding every attempt still inside the window. The window this package enforces
 * is a SLIDING one, so the instants are kept (a counter plus a window end is a fixed window, which
 * admits `maxAttempts` at the end of one and `maxAttempts` again at the start of the next). They
 * are kept IN the row because the row is what a concurrent take waits on: a count over a second
 * table reads its statement's snapshot, and that snapshot predates the wait.
 *
 * The two `add column` lines are the upgrade of a table made before the reservation, on the rule
 * `x_users` follows: additive, defaulted, idempotent, applied at every boot. The name and the
 * first two columns are unchanged on purpose — a replica still running the previous release reads
 * and writes this table as it always did, so a lockout holds on both sides of a rolling deploy.
 */
export const SQL_AUTH_LIMIT_TABLES = `
create table if not exists x_auth_lockouts (
  key             text     primary key,
  locked_until_ms bigint   not null,
  attempts_ms     bigint[] not null default '{}',
  admitted        boolean  not null default true
);

alter table x_auth_lockouts add column if not exists attempts_ms bigint[] not null default '{}';
alter table x_auth_lockouts add column if not exists admitted boolean not null default true;

create index if not exists x_auth_lockouts_until_idx on x_auth_lockouts (locked_until_ms);
`;

/**
 * The attempts still inside the window, read off the row as it is AFTER its lock is taken. It is
 * repeated in the statement below rather than computed once in a CTE, and the repetition is
 * required: only a direct `x_auth_lockouts.<column>` reference inside `on conflict do update` sees
 * what a concurrent take just committed. `$2` nowMs, `$3` windowMs.
 */
const LIVE =
  'array(select at_ms from unnest(x_auth_lockouts.attempts_ms) as at_ms ' +
  'where at_ms > $2::bigint - $3::bigint)';

const LOCKED = 'x_auth_lockouts.locked_until_ms > $2::bigint';

/**
 * `$1` key, `$2` nowMs, `$3` windowMs, `$4` lockoutMs, `$5` maxAttempts — the reservation, in ONE
 * statement: decide and count together, so N concurrent takes are admitted one at a time.
 *
 * A locked key is left untouched and answers `admitted = false`. Otherwise the attempt joins the
 * window and, if it fills it, starts the lockout. `admitted` is persisted because `returning`
 * cannot see the row as it was: the verdict has to be a column the statement wrote.
 *
 * A live lockout is never rewritten, so nothing arriving during one can shorten it. Inside a
 * caller's own transaction the row lock is held to that commit, which is what serialises two outer
 * transactions; `auth.ts` takes account → ip → org in that fixed order, so two sign-ins cannot
 * hold two of these rows in opposite orders.
 */
export const SQL_AUTH_TAKE = `
insert into x_auth_lockouts (key, attempts_ms, locked_until_ms, admitted)
values (
  $1,
  array[$2::bigint],
  case when 1 >= $5::bigint then $2::bigint + $4::bigint else 0 end,
  true
)
on conflict (key) do update
   set attempts_ms = case when ${LOCKED} then x_auth_lockouts.attempts_ms
                          else ${LIVE} || $2::bigint end,
       locked_until_ms = case
         when ${LOCKED} then x_auth_lockouts.locked_until_ms
         when cardinality(${LIVE}) + 1 >= $5::bigint then $2::bigint + $4::bigint
         else 0 end,
       admitted = not (${LOCKED})
returning admitted, locked_until_ms
`;

/** The window with the first entry equal to `$2` taken out — one reservation, never every equal one. */
const WITHOUT =
  '(attempts_ms[:array_position(attempts_ms, $2::bigint) - 1] || ' +
  'attempts_ms[array_position(attempts_ms, $2::bigint) + 1:])';

/**
 * `$1` key, `$2` the reservation's `atMs`, `$3` nowMs, `$4` windowMs, `$5` maxAttempts.
 *
 * Gives ONE attempt back, and lifts the lockout when what is left no longer fills the window — a
 * lockout the refunded attempt itself completed. A reservation that is no longer in the row (the
 * key was cleared, or purged) matches nothing and changes nothing.
 */
export const SQL_AUTH_REFUND = `
update x_auth_lockouts
   set attempts_ms = ${WITHOUT},
       locked_until_ms = case
         when (select count(*) from unnest(${WITHOUT}) as at_ms
                where at_ms > $3::bigint - $4::bigint) < $5::bigint then 0
         else locked_until_ms end
 where key = $1 and array_position(attempts_ms, $2::bigint) is not null
`;

/** `$2` is the caller's clock: an expired lockout answers exactly as a missing one. */
export const SQL_AUTH_LOCKED_UNTIL = `
select locked_until_ms from x_auth_lockouts where key = $1 and locked_until_ms > $2::bigint
`;

/** A success clears the window AND the lockout: they are one row, so they go together. */
export const SQL_AUTH_FORGET_KEY = 'delete from x_auth_lockouts where key = $1';

export const SQL_AUTH_RESET = 'delete from x_auth_lockouts';

/**
 * `$1` nowMs, `$2` windowMs — the CALLER's clock, never `now()`. Every instant in this table is
 * written from the caller's clock, so a purge measuring against the SERVER's would delete rows by
 * the offset between the two: attempts that are still inside the window, and lockouts that are
 * still live. The second one hands a sprayer its account back.
 */
export const SQL_AUTH_PURGE = `
with dropped as (
  delete from x_auth_lockouts
   where locked_until_ms <= $1::bigint
     and not exists (
       select 1 from unnest(attempts_ms) as at_ms where at_ms > $1::bigint - $2::bigint
     )
  returning key
)
select count(*) as removed from dropped
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
   * Drop every key whose window has emptied and whose lockout has expired, and answer how many
   * rows went. The table does not bound itself — `ipKey` mints one key per source address, so a
   * spray from an IPv6 /64 is a row per attempt — and Postgres forgets nothing on its own. An app runs this
   * from a `task`; a row this deletes answers exactly as a missing one, so it changes no decision.
   */
  purgeExpired(): Promise<number>;
}

interface LockRow {
  /** `bigint`, which every Postgres client hands back as a string. */
  readonly locked_until_ms: number | string;
}

interface TakeRow extends LockRow {
  readonly admitted: boolean;
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

    async reserve(key): Promise<AuthReservation> {
      const at = nowMs();
      const rows = await exec.query<TakeRow>(SQL_AUTH_TAKE, [
        key,
        at,
        policy.windowMs,
        policy.lockoutMs,
        policy.maxAttempts,
      ]);
      const row = rows[0];
      // No row is no verdict, and no verdict is not an admission: an executor that answered
      // nothing must not be read as "allowed" on the credential path.
      if (row === undefined) throw authWriteFailed('reserve', 'x_auth_lockouts');
      if (row.admitted !== true) {
        throw accountLocked(key, Math.ceil((Number(row.locked_until_ms) - at) / 1000));
      }
      return { key, atMs: at };
    },

    async refund(reservation): Promise<void> {
      await exec.query(SQL_AUTH_REFUND, [
        reservation.key,
        reservation.atMs,
        nowMs(),
        policy.windowMs,
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
