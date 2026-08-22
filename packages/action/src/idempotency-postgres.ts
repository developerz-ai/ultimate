/**
 * The shared idempotency store: one Postgres table, `insert … on conflict` for the atomicity.
 * This is the store the memory default's own comment has promised since the primitive shipped —
 * without it, `replicas: 3` means a retry that lands elsewhere re-runs a committed handler.
 * Statements are spelled out so an agent can run the exact one it saw in a log.
 */
import { logger, uuid } from '@ultimat3/core';
import { IdempotencyStatusUnknownError } from './errors';
import type {
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStore,
} from './idempotency';
import { IDEMPOTENCY_STATUSES, isIdempotencyStatus } from './idempotency';
import { DEFAULT_IDEMPOTENCY_WINDOW_MS } from './idempotency-memory';

/**
 * The one thing this store needs from the DB layer, declared structurally rather than imported.
 * `@ultimat3/jobs` declares the same shape for the same reason: neither package owns the other's
 * connection, and neither depends on a database package.
 *
 * **`Bun.sql` does not satisfy it** — verified against Bun 1.3.14: `Bun.sql.query` is `undefined`.
 * `Bun.sql` is a tagged template whose positional form is `unsafe`, so `{ executor: Bun.sql }`
 * would `TypeError` on the first reservation, which is the one call path that must not fail open.
 * What satisfies it is a client that already speaks `(text, values)`, wrapped in one line —
 * `@ultimat3/cli`'s `pgExecutorFor(client)` over `@ultimat3/db`'s `DbClient.query({ text, values })`
 * is the framework's own — or a transaction handle, which is a client on its own connection.
 */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}

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
`;

/**
 * The reservation, atomic in one statement. The `do update` fires ONLY for a row already outside
 * the window — which answers as a missing one — so a returned row always means this caller owns
 * the reservation and must run the handler. No row back means a live record exists and belongs to
 * someone else.
 */
export const SQL_IDEMPOTENCY_RESERVE = `
insert into x_idempotency (key, id, request_hash, status)
values ($1, $2, $3, 'in-flight')
on conflict (key) do update
   set id           = excluded.id,
       request_hash = excluded.request_hash,
       status       = 'in-flight',
       value        = null,
       failure      = null,
       created_at   = now()
 where x_idempotency.created_at < now() - make_interval(secs => $4::double precision)
returning key, id, request_hash, status, value, failure,
          (extract(epoch from created_at) * 1000)::bigint as created_at
`;

export const SQL_IDEMPOTENCY_GET = `
select key, id, request_hash, status, value, failure,
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
update x_idempotency set status = 'settled', value = $2::jsonb, failure = null
 where key = $1 and id = $3::uuid and status = 'in-flight'
returning key
`;

export const SQL_IDEMPOTENCY_FAIL = `
update x_idempotency set status = 'failed', value = null, failure = $2::jsonb
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
  /** `bigint`, which every Postgres client hands back as a string. */
  readonly created_at: number | string;
}

export interface PostgresIdempotencyStoreOptions {
  readonly executor: PgExecutor;
  readonly windowMs?: number | undefined;
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
 * calls `setIdempotencyStore(postgresIdempotencyStore({ executor }))` before `loadApp`, so the
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
 *   }),
 * );
 * ```
 */
export function postgresIdempotencyStore(
  options: PostgresIdempotencyStoreOptions,
): PostgresIdempotencyStore {
  const windowMs = Math.max(1, Math.floor(options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS));
  const windowSecs = windowMs / 1000;
  const exec = options.executor;
  const now = options.now ?? ((): number => Date.now());

  const fetch = async (key: string): Promise<IdempotencyRecord | undefined> => {
    const rows = await exec.query<IdempotencyRow>(SQL_IDEMPOTENCY_GET, [key, windowSecs]);
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  };

  return {
    scope: 'shared',
    windowMs,

    async reserve(key, requestHash): Promise<IdempotencyReservation> {
      // A bounded loop, not a `while (true)`: the only way the insert and the read can both come
      // back empty is a concurrent `release`/`purgeExpired` deleting the row between them, and a
      // caller losing that race twice is a store nobody should keep retrying against.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claimed = await exec.query<IdempotencyRow>(SQL_IDEMPOTENCY_RESERVE, [
          key,
          uuid(),
          requestHash,
          windowSecs,
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
          id: uuid(),
          key,
          requestHash,
          status: 'in-flight',
          value: undefined,
          createdAt: now(),
        },
        created: false,
      };
    },

    async settle(key, value, reservationId): Promise<void> {
      const rows = await exec.query(SQL_IDEMPOTENCY_SETTLE, [
        key,
        JSON.stringify(value ?? null),
        reservationId,
      ]);
      fenced(rows, key, reservationId, 'settle');
    },

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
 * Logged, never thrown. A settlement lands after the handler has committed, so raising here would
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
