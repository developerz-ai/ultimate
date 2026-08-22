/**
 * The shared rate-limit store: one Postgres table, one `insert … on conflict` per take, so N
 * replicas count against one bucket. Without it `config.rateLimit.scope: 'shared'` is a
 * declaration nothing can satisfy — `assertRateLimitScope` refuses every store the framework
 * shipped — and `docker/helm/values.yaml` runs `roles.web.replicas: 3`. Statements are spelled
 * out so an agent can run the exact one it saw in a log.
 */

import type { RateLimitDecision, RateLimitScope, RateLimitStore } from './rate-limit';
import { rateLimitDecision } from './rate-limit';
import { rateLimitStoreUnavailable } from './rate-limit-errors';

/**
 * The one thing this store needs from the DB layer, declared structurally rather than imported —
 * `@ultimat3/action`'s `idempotency-postgres.ts` and `@ultimat3/jobs` declare the same shape for
 * the same reason: neither package owns the other's connection. Here it is also the only option:
 * `@ultimat3/http` has no `@ultimat3/db` dependency at all, and taking one to type a single method
 * would put the whole database package in this package's install graph.
 *
 * **`Bun.sql` does not satisfy it** — `Bun.sql.query` is `undefined`; it is a tagged template whose
 * positional form is `unsafe`. What satisfies it is a client that already speaks `(text, values)`,
 * wrapped in one line — `@ultimat3/db`'s `DbClient.query({ text, values })` is the framework's own.
 */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}

/**
 * Installed by the boot, not by an app migration — the same rule `SQL_IDEMPOTENCY_TABLE` follows,
 * so `x dev`, the container's `web` role and the release-phase `ROLE=migrate` all apply it.
 *
 * `capacity` and `refill_per_second` are STORED, though every take passes them: they are what
 * makes `purgeExpired` able to ask "has this bucket refilled to full?" — the same question the
 * memory store answers with `forgetAtMs` — instead of guessing an idle TTL that is wrong for any
 * app declaring a window longer than the guess.
 */
export const SQL_RATE_LIMIT_TABLE = `
create table if not exists x_rate_limit (
  key               text             primary key,
  tokens            double precision not null,
  capacity          double precision not null,
  refill_per_second double precision not null,
  last_ms           bigint           not null,
  spent             boolean          not null,
  updated_at        timestamptz      not null default now()
);

create index if not exists x_rate_limit_updated_at_idx on x_rate_limit (updated_at);
`;

/**
 * What the bucket holds after the elapsed refill, before this caller spends anything — capped at
 * `capacity`, and never negative elapsed, so a replica whose clock runs behind grants nothing.
 *
 * It appears four times in the statement below and that repetition is REQUIRED, not sloppiness.
 * Only a direct `x_rate_limit.<column>` reference inside `on conflict do update` reads the row as
 * it is after the lock is taken; a CTE computing it once would read the statement's own snapshot,
 * so two concurrent takes would each compute from the same pre-refill row and one spend would be
 * lost — a free request per race, on the control that exists to refuse them.
 */
const REFILLED =
  'least($2::double precision, x_rate_limit.tokens + ' +
  'greatest(0, ($5::bigint - x_rate_limit.last_ms))::double precision / 1000 * $3::double precision)';

/**
 * `$1` key, `$2` capacity, `$3` refill per second, `$4` cost, `$5` the caller's `nowMs`.
 *
 * `spent` is persisted because the token count alone cannot answer the caller: a take that landed
 * at 0.5 and a refusal that left 0.5 are the same number, and `rateLimitDecision` needs the
 * verdict to compute `retryAfterSeconds`. `last_ms` only ever moves FORWARD (`greatest`) — two
 * replicas do not share a clock, and a `last_ms` dragged backwards hands the next take a longer
 * elapsed than really passed, which is refill the caller did not earn.
 */
export const SQL_RATE_LIMIT_TAKE = `
insert into x_rate_limit (key, tokens, capacity, refill_per_second, last_ms, spent)
values (
  $1,
  case when $2::double precision >= $4::double precision
       then $2::double precision - $4::double precision
       else $2::double precision end,
  $2::double precision, $3::double precision, $5::bigint,
  $2::double precision >= $4::double precision
)
on conflict (key) do update
   set tokens = case
         when ${REFILLED} >= $4::double precision
         then ${REFILLED} - $4::double precision
         else ${REFILLED} end,
       capacity          = $2::double precision,
       refill_per_second = $3::double precision,
       last_ms           = greatest(x_rate_limit.last_ms, $5::bigint),
       spent             = ${REFILLED} >= $4::double precision,
       updated_at        = now()
returning tokens, spent
`;

export const SQL_RATE_LIMIT_RESET = 'delete from x_rate_limit where key = $1';

/**
 * The memory store's forget rule, in SQL: a bucket back at capacity answers exactly as a missing
 * one, so dropping it changes no decision. A bucket that never refills
 * (`refill_per_second <= 0`) is never forgotten, exactly as the memory store's `Infinity` forget
 * instant says.
 *
 * `$1` is the CALLER's `nowMs`, and using `extract(epoch from now())` instead is a bug this
 * statement shipped with for one afternoon. `last_ms` is written from the caller's clock, so a
 * purge measuring against the SERVER's clock computes a refill out of the offset between the two
 * — and every bucket a throttled caller is sitting in is deleted, which is a free reset. Measured:
 * the framework's own test preload freezes the clock at 2026-01-01, the server said 2026-08-22,
 * and the purge dropped a bucket holding 0 of 4 tokens.
 */
export const SQL_RATE_LIMIT_PURGE = `
delete from x_rate_limit
 where refill_per_second > 0
   and tokens
       + greatest(0, $1::bigint - last_ms)::double precision / 1000
         * refill_per_second >= capacity
`;

interface TakeRow {
  /** `double precision`, which some clients hand back as a string. */
  readonly tokens: number | string;
  /** `boolean`, which a text-mode client hands back as `'t'`. */
  readonly spent: boolean | string;
}

export interface PostgresRateLimitStoreOptions {
  readonly executor: PgExecutor;
}

export interface PostgresRateLimitStore extends RateLimitStore {
  readonly scope: RateLimitScope;
  /**
   * Delete every bucket that has refilled to capacity, and answer how many. The table is the one
   * part of this store that does not bound itself — Postgres forgets nothing on its own, and the
   * key falls back to the connection address, so a scan rotating through an IPv6 /64 mints a row
   * per request. An app runs this from a `task` on whatever cadence its traffic deserves.
   *
   * `nowMs` is required and comes from the SAME clock the takes use — `ctx.now().getTime()` in a
   * task. There is no default, because the only defensible default would be this process' own
   * `Date.now()`, and a store that reads a clock nobody handed it is the thing `createRateLimiter`
   * took a `Clock` to stop.
   */
  purgeExpired(nowMs: number): Promise<number>;
}

/**
 * **Install it at boot, beside the config that declares the scope.** The app owes two lines:
 *
 * ```ts
 * // app.config.ts — what this deployment REQUIRES
 * http: { rateLimit: { scope: 'shared' } }
 *
 * // apps/web/server.ts — what PROVIDES it
 * const client = db();
 * createServer({
 *   rateLimitStore: postgresRateLimitStore({
 *     executor: { query: (text, values) => client.query({ text, values }) },
 *   }),
 * });
 * ```
 *
 * `assertRateLimitScope` compares the two once, inside `createPipeline`, and a `'shared'`
 * declaration over any other store is `X_RATE_LIMIT_NOT_SHARED` before the socket opens.
 */
export function postgresRateLimitStore(
  options: PostgresRateLimitStoreOptions,
): PostgresRateLimitStore {
  const exec = options.executor;

  return {
    scope: 'shared',

    async take(key, bucket, cost, nowMs): Promise<RateLimitDecision> {
      const rows = await exec.query<TakeRow>(SQL_RATE_LIMIT_TAKE, [
        key,
        bucket.capacity,
        bucket.refillPerSecond,
        cost,
        Math.floor(nowMs),
      ]);
      const row = rows[0];
      // An upsert with `returning` answers exactly one row, so none means the executor is not
      // running the statement it was handed. Refusing loudly beats inventing a decision: the
      // invented one would be "allowed", which is the limiter silently switched off.
      if (row === undefined) throw rateLimitStoreUnavailable('take');
      return rateLimitDecision(bucket, Number(row.tokens), cost, isTrue(row.spent), nowMs);
    },

    async reset(key): Promise<void> {
      await exec.query(SQL_RATE_LIMIT_RESET, [key]);
    },

    async purgeExpired(nowMs): Promise<number> {
      const rows = await exec.query<{ readonly key: string }>(
        `${SQL_RATE_LIMIT_PURGE} returning key`,
        [Math.floor(nowMs)],
      );
      return rows.length;
    },
  };
}

/** A `boolean` column, read from a client that may be in text mode. */
const isTrue = (value: boolean | string): boolean => value === true || value === 't';
