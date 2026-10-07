/**
 * The shared idempotency store: one Postgres table, `insert … on conflict` for the atomicity.
 * This is the store the memory default's own comment has promised since the primitive shipped —
 * without it, `replicas: 3` means a retry that lands elsewhere re-runs a committed handler.
 * Statements are spelled out so an agent can run the exact one it saw in a log.
 */
import type { PgExecutor } from '@ultimat3/core';
import { finiteCount, logger, uuidV7 } from '@ultimat3/core';
import { IdempotencyReservationLostError, IdempotencyStatusUnknownError } from './errors';
import type {
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStore,
} from './idempotency';
import { IDEMPOTENCY_STATUSES, isIdempotencyStatus } from './idempotency';
import { DEFAULT_IDEMPOTENCY_WINDOW_MS } from './idempotency-memory';
import { liveTransaction } from './tx-scope';

/**
 * The store's ONE install point, applied the way `SQL_JOBS_TABLE` is — by the boot, not by an app
 * migration: `startQueue` runs both on every start, so `x dev`, the container's `web`/`worker` and
 * the release-phase `ROLE=migrate` all apply it. `create table if not exists` is a no-op against a
 * database that already has it, so a new column is added by `alter table … add column if not
 * exists` and never by editing the `create`.
 */
export const SQL_IDEMPOTENCY_TABLE = `
create table if not exists x_idempotency (
  key          text        primary key,
  id           uuid        not null,
  request_hash text        not null,
  status       text        not null default 'in-flight',
  value        jsonb,
  failure      jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists x_idempotency_created_at_idx on x_idempotency (created_at);

alter table x_idempotency add column if not exists tx_bound boolean not null default false;

alter table x_idempotency add column if not exists redacted boolean not null default false;
`;

/**
 * The reservation, atomic in one statement. The `do update` fires ONLY for a row that answers as a
 * missing one, so a returned row always means this caller owns the reservation and must run the
 * handler. No row back means a live record exists and belongs to someone else.
 *
 * Two rows answer as missing. One outside the window. And one still `in-flight` past the request
 * deadline (`$6`) whose settlement was BOUND TO A TRANSACTION (`tx_bound`): that settle commits
 * with the handler's writes or not at all, so the record being in flight proves nothing committed
 * — the process died, or the unit of work rolled back. An autocommit handler's record is never
 * reclaimed this way: "died before the write" and "wrote, then died before the settle" are one
 * row, and re-running the second is the double charge.
 */
export const SQL_IDEMPOTENCY_RESERVE = `
insert into x_idempotency (key, id, request_hash, status, tx_bound)
values ($1, $2, $3, 'in-flight', $5)
on conflict (key) do update
   set id           = excluded.id,
       request_hash = excluded.request_hash,
       status       = 'in-flight',
       value        = null,
       failure      = null,
       redacted     = false,
       tx_bound     = excluded.tx_bound,
       created_at   = now()
 where x_idempotency.created_at < now() - make_interval(secs => $4::double precision)
    or (x_idempotency.status = 'in-flight'
        and x_idempotency.tx_bound
        and x_idempotency.created_at < now() - make_interval(secs => $6::double precision))
returning key, id, request_hash, status, value, failure, redacted,
          (extract(epoch from created_at) * 1000)::bigint as created_at
`;

export const SQL_IDEMPOTENCY_GET = `
select key, id, request_hash, status, value, failure, redacted,
       (extract(epoch from created_at) * 1000)::bigint as created_at
  from x_idempotency
 where key = $1
   and created_at >= now() - make_interval(secs => $2::double precision)
`;

/**
 * `and id = $3 and status = 'in-flight'` is a FENCE, not a filter — the one `@ultimat3/jobs`'
 * `SQL_ACK` carries as `where id = $1 and state = 'running'`, for the same failure. A reservation
 * whose window lapsed is reclaimed by the next caller (`do update` above), so a straggler from the
 * first one arriving afterwards overwrote a record it no longer owned: the next replay under that
 * key answered a retry with a value produced for a different request.
 *
 * BOTH halves, because either alone leaves a case open. The status alone misses the reclaimed
 * record — it is `in-flight` again, belonging to someone else — and the id alone would let a
 * straggler overwrite a record its own attempt had already settled. `returning key` is what makes
 * the refusal observable: an update matching no row is indistinguishable from one that matched.
 */
export const SQL_IDEMPOTENCY_SETTLE = `
update x_idempotency set status = 'settled', value = $2::jsonb, failure = null,
       redacted = $4::boolean
 where key = $1 and id = $3::uuid and status = 'in-flight'
returning key
`;

export const SQL_IDEMPOTENCY_FAIL = `
update x_idempotency set status = 'failed', value = null, failure = $2::jsonb,
       redacted = false
 where key = $1 and id = $3::uuid and status = 'in-flight'
returning key
`;

export const SQL_IDEMPOTENCY_RELEASE = `delete from x_idempotency where key = $1`;

export const SQL_IDEMPOTENCY_PURGE = `
delete from x_idempotency where created_at < now() - make_interval(secs => $1::double precision)
`;

interface IdempotencyRow {
  readonly key: string;
  readonly id: string;
  readonly request_hash: string;
  readonly status: string;
  readonly value: unknown;
  readonly failure: unknown;
  /** Absent on a row read by a statement that predates the column — read as `false`. */
  readonly redacted?: boolean | undefined;
  /** `bigint`, which every Postgres client hands back as a string. */
  readonly created_at: number | string;
}

export interface PostgresIdempotencyStoreOptions {
  readonly executor: PgExecutor;
  /**
   * The client transactions on THIS database are opened on — `baseClient` from `@ultimat3/db` for
   * the store the boot installs. Compared by identity with an open transaction's `origin`: the
   * settle rides a transaction on this database and no other. One opened elsewhere
   * (`withTransaction(fn, { client: shard })`) has no `x_idempotency` to settle in, so the record
   * is settled on the pool, exactly as an autocommit handler's is. REQUIRED: a store that could
   * not tell would send the settle to whichever database the handler happened to be writing.
   */
  readonly origin: () => object;
  readonly windowMs?: number | undefined;
  /**
   * The request deadline in milliseconds, read at every reservation: how long an in-flight record
   * whose settlement rides a transaction is kept before a retry may take the key. REQUIRED and a
   * function — the deadline is the app's (`requestTimeoutMs`), declared after this store is built,
   * and a number restated here would silently disagree with it. `0` is "no deadline": nothing is
   * reclaimed before the window. Never applies to an autocommit handler's record.
   */
  readonly reclaimAfterMs: () => number;
  /**
   * Injectable, exactly as `MemoryIdempotencyStoreOptions.now` is. The two stores are one seam and
   * a caller must be able to drive either from the same clock; a hardcoded `Date.now()` here made
   * the one record this store stamps itself untestable and unfreezable.
   */
  readonly now?: (() => number) | undefined;
}

export interface PostgresIdempotencyStore extends IdempotencyStore {
  readonly scope: IdempotencyScope;
  readonly windowMs: number;
  /**
   * Delete every record past the window, and answer how many. The table is the one part of this
   * store that does not bound itself — Postgres forgets nothing on its own — so an app runs this
   * from a `task` on whatever cadence its write rate deserves.
   */
  purgeExpired(): Promise<number>;
}

/**
 * **The boot installs this for you — an app declares the scope and nothing else.**
 * `@ultimat3/cli`'s `startServices` builds a `PgExecutor` from the client it already resolved and
 * calls `setIdempotencyStore(postgresIdempotencyStore({ executor, origin, reclaimAfterMs }))` before `loadApp`, so the
 * store is in place by the time `registerAction` evaluates a declaration against it. All an app
 * owes is the one line `x new` scaffolds into `apps/web/server.ts`:
 *
 * ```ts
 * configureIdempotency({ scope: 'shared' });
 * ```
 *
 * Installing one by hand is for a host that boots the framework itself, and it needs a real
 * `PgExecutor` — never `Bun.sql`, which has no `.query`. Wrap the client this process already
 * opened, so a second pool is not opened against a URL the boot resolved once:
 *
 * ```ts
 * const client = db();
 * setIdempotencyStore(
 *   postgresIdempotencyStore({
 *     executor: { query: (text, values) => client.query({ text, values }) },
 *     origin: () => client,
 *     reclaimAfterMs: requestDeadlineMs, // the app's `requestTimeoutMs`, from '@ultimat3/action'
 *   }),
 * );
 * ```
 */
export function postgresIdempotencyStore(
  options: PostgresIdempotencyStoreOptions,
): PostgresIdempotencyStore {
  // The same screen as the memory store's, on the number that becomes `windowSecs` and is bound
  // into every statement below: `Math.floor(NaN)` is `NaN`, and NaN/1000 is what reaches Postgres.
  const windowMs = finiteCount(
    'postgresIdempotencyStore',
    'windowMs',
    options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
    1,
  );
  const windowSecs = windowMs / 1000;
  // Screened on every read, like the window above: the value is the app's and arrives late. Never
  // past the window, which already frees the record — and `0` means exactly that.
  const reclaimSecs = (): number => {
    const ms = finiteCount('postgresIdempotencyStore', 'reclaimAfterMs', options.reclaimAfterMs());
    return (ms === 0 ? windowMs : Math.min(ms, windowMs)) / 1000;
  };
  const exec = options.executor;
  /** The executor of a transaction open on THIS database, or `undefined` — the pool settles. */
  const boundTx = (): PgExecutor | undefined => {
    const tx = liveTransaction();
    return tx !== undefined && tx.origin === options.origin() ? tx.executor : undefined;
  };
  const now = options.now ?? ((): number => Date.now());

  const fetch = async (key: string): Promise<IdempotencyRecord | undefined> => {
    const rows = await exec.query<IdempotencyRow>(SQL_IDEMPOTENCY_GET, [key, windowSecs]);
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  };

  return {
    scope: 'shared',
    keepsRedaction: true,
    windowMs,

    async reserve(key, requestHash): Promise<IdempotencyReservation> {
      // A bounded loop, not a `while (true)`: the only way the insert and the read can both come
      // back empty is a concurrent `release`/`purgeExpired` deleting the row between them, and a
      // caller losing that race twice is a store nobody should keep retrying against.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // On the POOL, never the open transaction: a duplicate has to see the reservation now,
        // and one that rolled back with the handler would let both attempts run. What rides the
        // transaction is the SETTLE — and the row says so, which is what makes it reclaimable.
        const claimed = await exec.query<IdempotencyRow>(SQL_IDEMPOTENCY_RESERVE, [
          key,
          uuidV7(),
          requestHash,
          windowSecs,
          boundTx() !== undefined,
          reclaimSecs(),
        ]);
        const row = claimed[0];
        if (row !== undefined) return { record: toRecord(row), created: true };
        const existing = await fetch(key);
        if (existing !== undefined) return { record: existing, created: false };
      }
      // Reported as a fresh reservation rather than a throw would be wrong in the one direction
      // that matters, so this is the honest answer: the caller sees the in-flight refusal.
      return {
        record: {
          id: uuidV7(),
          key,
          requestHash,
          status: 'in-flight',
          value: undefined,
          createdAt: now(),
        },
        created: false,
      };
    },

    // `value` is the resting copy `withIdempotency` redacted; `redacted` is kept beside it so the
    // replay is refused by a column, never by searching the stored JSON for a marker string.
    async settle(key, value, reservationId, redacted): Promise<void> {
      const params = [key, JSON.stringify(value ?? null), reservationId, redacted];
      const tx = boundTx();
      if (tx === undefined) {
        fenced(await exec.query(SQL_IDEMPOTENCY_SETTLE, params), key, reservationId, 'settle');
        return;
      }
      // On the handler's OWN connection: the record is settled by the same COMMIT that makes the
      // write durable, so a rollback leaves it in flight instead of replaying a success for rows
      // that were never stored. And a settle that matches nothing here is THROWN, not logged —
      // the key was taken over, nothing has committed yet, and the throw is what rolls it back.
      const rows = await tx.query(SQL_IDEMPOTENCY_SETTLE, params);
      if (rows.length === 0) throw new IdempotencyReservationLostError(key);
    },

    // On the pool, whatever is open: the transaction this failure came out of is about to roll
    // back, and the record of it has to outlive that.
    async fail(key, failure: IdempotencyFailure, reservationId): Promise<void> {
      const rows = await exec.query(SQL_IDEMPOTENCY_FAIL, [
        key,
        JSON.stringify(failure),
        reservationId,
      ]);
      fenced(rows, key, reservationId, 'fail');
    },

    async release(key): Promise<void> {
      await exec.query(SQL_IDEMPOTENCY_RELEASE, [key]);
    },

    get: fetch,

    async purgeExpired(): Promise<number> {
      const rows = await exec.query<{ readonly key: string }>(
        `${SQL_IDEMPOTENCY_PURGE} returning key`,
        [windowSecs],
      );
      return rows.length;
    },
  };
}

/**
 * Logged, never thrown — the AUTOCOMMIT path. A settlement lands after the handler has committed, so raising here would
 * turn a durable write into the caller's error — the rule `withIdempotency` already follows for a
 * store that refuses. An operator still has to see it: a fenced settle means this attempt's record
 * belongs to another reservation, and the value this attempt produced is stored nowhere.
 */
function fenced(
  rows: readonly unknown[],
  key: string,
  reservationId: string,
  statement: 'settle' | 'fail',
): void {
  if (rows.length > 0) return;
  logger.warn('action.idempotency.settlement-fenced', { key, reservationId, statement });
}

/**
 * The narrowing, never a cast. `row.status as IdempotencyStatus` let an unknown word through, and
 * `withIdempotency` has no branch for one: it fell past `in-flight` and `failed` and answered
 * `{ value: null, replayed: true }` — "this already ran, here is its result" — for a record nobody
 * could read. The rule `@ultimat3/jobs`' `statusIn` already writes out for the same column.
 */
function toRecord(row: IdempotencyRow): IdempotencyRecord {
  const failure = toFailure(row.failure);
  if (!isIdempotencyStatus(row.status)) {
    throw new IdempotencyStatusUnknownError({
      key: row.key,
      value: row.status,
      known: IDEMPOTENCY_STATUSES,
    });
  }
  return {
    id: row.id,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    value: row.value,
    ...(failure === undefined ? {} : { failure }),
    ...(row.redacted === true ? { redacted: true } : {}),
    createdAt: Number(row.created_at),
  };
}

/** `jsonb` comes back as parsed JSON, so this is a shape check and never a second parse. */
function toFailure(value: unknown): IdempotencyFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const code = record['code'];
  const cause = record['cause'];
  const fix = record['fix'];
  if (typeof code !== 'string' || typeof cause !== 'string' || typeof fix !== 'string') {
    return undefined;
  }
  const docs = record['docs'];
  return { code, cause, fix, ...(typeof docs === 'string' ? { docs } : {}) };
}
