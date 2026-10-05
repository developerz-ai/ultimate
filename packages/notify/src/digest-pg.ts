// The Postgres digest store: one row per window, so a `digested` event outlives the process that
// appended it and every replica coalesces into the same window. `createMemoryDigestStore` is the
// same queue of windows in one heap; this is what a deployment with more than one process installs.

import type { PgExecutor } from '@ultimat3/core';
import { finiteCount, UltimateError } from '@ultimat3/core';
import type { DigestSlot, DigestStore } from './digest';
import type { NotifyEvent } from './notification';

/**
 * Applied by the boot beside `SQL_NOTIFY_DELIVERIES_TABLE` and `SQL_NOTIFY_INBOX_TABLE`, never by
 * an app migration — a new column is `alter table … add column if not exists`, never an edit here.
 *
 * The PARTIAL unique index is the whole concurrency story: at most one OPEN window per slot, so two
 * replicas appending the first event of a window at once collide on it and exactly one of them
 * opens the window and owns its flush. A window is SEALED once it has elapsed and an append wanted
 * a new one; sealed windows wait for their flush and are not indexed, so a slot can hold several.
 */
export const SQL_NOTIFY_DIGESTS_TABLE = `
create table if not exists x_notify_digests (
  seq        bigint      generated always as identity primary key,
  recipient  text        not null,
  notifier   text        not null,
  channel    text        not null,
  group_key  text        not null,
  ends_at    timestamptz not null,
  sealed     boolean     not null default false,
  events     jsonb       not null
);

create unique index if not exists x_notify_digests_open_idx
  on x_notify_digests (recipient, notifier, channel, group_key) where not sealed;

create index if not exists x_notify_digests_slot_idx
  on x_notify_digests (recipient, notifier, channel, group_key, ends_at);

create index if not exists x_notify_digests_ends_idx on x_notify_digests (ends_at);

alter table x_notify_digests add column if not exists appended_by text[] not null default '{}';
`;

/**
 * Join the open window, or open one — unless this appender (`$8`) already landed in a window of the
 * slot, which is a replayed step: then that window's answer comes back and nothing is written.
 * `appended_by[1]` is the opener, so a replay by the opener still reads `opened`, and owns the
 * flush it owned the first time. `(xmax = 0)` is true for the row this statement INSERTED and false
 * for one it updated. An open window that has already elapsed is not joined: the `where` on the
 * `do update` refuses it and no row comes back, which is the store's cue to seal it and try again.
 * A row written before `appended_by` existed holds `'{}'`, matches no appender, and opens nothing.
 *
 * The `any` on the `do update` is for two executions of ONE appender at once (a lapsed lease): both
 * pass `prior` in their own snapshots, and the loser's conflict re-reads the winner's COMMITTED row.
 * It refuses to join it twice and no row comes back — the store's next pass then finds it in
 * `prior`, exactly as it finds an elapsed window sealed.
 */
export const SQL_NOTIFY_DIGEST_APPEND = `
with prior as (
  select ends_at, coalesce(appended_by[1] = $8::text, false) as opened
  from x_notify_digests
  where recipient = $1 and notifier = $2 and channel = $3 and group_key = $4
    and $8::text = any(appended_by)
  order by seq
  limit 1
), joined as (
  insert into x_notify_digests (recipient, notifier, channel, group_key, ends_at, events, appended_by)
  select $1, $2, $3, $4, $6::timestamptz, $5::jsonb, array[$8::text]
  where not exists (select 1 from prior)
  on conflict (recipient, notifier, channel, group_key) where not sealed
  do update set events = x_notify_digests.events || excluded.events,
    appended_by = x_notify_digests.appended_by || excluded.appended_by
  where x_notify_digests.ends_at > $7::timestamptz
    and not ($8::text = any(x_notify_digests.appended_by))
  returning ends_at, (xmax = 0) as opened
)
select ends_at, opened from prior
union all
select ends_at, opened from joined
`;

/** Seal the slot's open window once it has elapsed, so the next append opens a fresh one. */
export const SQL_NOTIFY_DIGEST_SEAL = `
update x_notify_digests set sealed = true
where recipient = $1 and notifier = $2 and channel = $3 and group_key = $4
  and not sealed and ends_at <= $5
`;

/**
 * Take every window closing at or before `$5` — its own and an older one a crashed flush left —
 * or, with `$5` null, the oldest window alone. Oldest first, by close time and then by the order
 * the windows were opened in, which is what the memory store's queue answers.
 */
export const SQL_NOTIFY_DIGEST_DRAIN = `
with taken as (
  delete from x_notify_digests
  where recipient = $1 and notifier = $2 and channel = $3 and group_key = $4
    and (
      ($5::timestamptz is not null and ends_at <= $5)
      or ($5::timestamptz is null and seq = (
        select min(seq) from x_notify_digests
        where recipient = $1 and notifier = $2 and channel = $3 and group_key = $4
      ))
    )
  returning seq, ends_at, events
)
select events from taken order by ends_at, seq
`;

/**
 * The retention sweep's one statement: windows that CLOSED before `$1`, oldest first, at most `$2`
 * of them. A window is deleted by its own flush's drain or by the next window's drain of the slot;
 * this catches the one neither reaches — a flush that dead-lettered on a slot that never digests
 * again. Bounded per statement, so one pass never holds a lock across the whole table.
 */
export const SQL_NOTIFY_DIGESTS_PURGE = `
delete from x_notify_digests
where seq in (
  select seq from x_notify_digests where ends_at < $1 order by ends_at, seq limit $2
)
returning seq
`;

/**
 * How long a CLOSED window is kept before the sweep may take it: a week. Longer than any retry
 * schedule a notifier's flush runs on, so the sweep only ever takes a window whose flush is gone.
 */
export const DEFAULT_DIGEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows per delete statement. */
export const DIGEST_PURGE_BATCH = 1000;
/** Statements per pass: the hourly sweep goes on where this one stopped. */
export const DIGEST_PURGE_MAX_BATCHES = 50;

/** Each seal answers one elapsed window; more than this in one append is clocks that disagree. */
const MAX_SEALS = 8;

interface AppendRow {
  readonly ends_at: Date | string;
  readonly opened: boolean;
}

/** `at` round-trips through jsonb as an ISO string; the type promises a `Date`, so it is rebuilt. */
interface StoredEvent extends Omit<NotifyEvent<unknown>, 'at'> {
  readonly at: string;
}

interface DrainRow {
  readonly events: readonly StoredEvent[];
}

const slotArgs = (slot: DigestSlot): readonly unknown[] => [
  slot.recipient,
  slot.notifier,
  slot.channel,
  slot.group,
];

const epochOf = (value: Date | string): number =>
  (value instanceof Date ? value : new Date(value)).getTime();

export interface PgDigestStoreOptions {
  readonly executor: PgExecutor;
  /** How long a closed window is kept. Defaults to `DEFAULT_DIGEST_RETENTION_MS`. */
  readonly retentionMs?: number | undefined;
}

/**
 * The Postgres store's own wider type, exactly as `PgDeliveryLedger` is: `purgeExpired` is not on
 * `DigestStore`, because a heap map bounded by process life has nothing to delete and a new
 * method on the seam breaks every app that wrote its own store.
 */
export interface PgDigestStore extends DigestStore {
  readonly retentionMs: number;
  /** Delete windows closed more than `retentionMs` before `nowMs` (the job's clock); answer how many. */
  purgeExpired(nowMs: number): Promise<number>;
}

export function createPgDigestStore(options: PgDigestStoreOptions): PgDigestStore {
  const { executor } = options;
  const retentionMs = finiteCount(
    'createPgDigestStore',
    'retentionMs',
    options.retentionMs ?? DEFAULT_DIGEST_RETENTION_MS,
    1,
  );
  return {
    retentionMs,
    async purgeExpired(nowMs) {
      // The JOB's clock, as the ledger's sweep: `ends_at` was computed from the appender's clock.
      const before = new Date(finiteCount('purgeExpired', 'nowMs', nowMs, 0) - retentionMs);
      let removed = 0;
      for (let batch = 0; batch < DIGEST_PURGE_MAX_BATCHES; batch += 1) {
        const rows = await executor.query<{ seq: number }>(SQL_NOTIFY_DIGESTS_PURGE, [
          before,
          DIGEST_PURGE_BATCH,
        ]);
        removed += rows.length;
        if (rows.length < DIGEST_PURGE_BATCH) break;
      }
      return removed;
    },
    async append(input) {
      const slot = slotArgs(input.slot);
      const now = input.now;
      const events = JSON.stringify([input.event]);
      const endsAt = new Date(now.getTime() + input.windowMs);
      for (let seals = 0; seals <= MAX_SEALS; seals += 1) {
        const [row] = await executor.query<AppendRow>(SQL_NOTIFY_DIGEST_APPEND, [
          ...slot,
          events,
          endsAt,
          now,
          input.appender,
        ]);
        if (row !== undefined) return { opened: row.opened, endsAt: epochOf(row.ends_at) };
        // No row: the open window elapsed, or this appender's own twin committed it first. The seal
        // is a no-op on a window still open, and either way the next pass answers from `prior`.
        await executor.query(SQL_NOTIFY_DIGEST_SEAL, [...slot, now]);
      }
      // Reached only when every retry met a window that ANOTHER appender had just opened and that
      // had already elapsed by this process's clock — two replicas a whole window apart in time.
      throw new UltimateError({
        code: 'X_INVARIANT',
        cause: `the digest window for notifier "${input.slot.notifier}" kept closing before this append could join it (${String(MAX_SEALS)} seals): its ${String(input.windowMs)} ms window is shorter than one append's round trip, or two replicas' clocks are a whole window apart`,
        fix: 'psql "$DATABASE_URL" -c "select notifier, recipient, ends_at, sealed, now() from x_notify_digests order by ends_at desc limit 10"',
        meta: { notifier: input.slot.notifier, seals: MAX_SEALS },
      });
    },
    async drain(slot, endsAt) {
      const rows = await executor.query<DrainRow>(SQL_NOTIFY_DIGEST_DRAIN, [
        ...slotArgs(slot),
        endsAt === undefined ? null : new Date(endsAt),
      ]);
      return rows.flatMap((row) =>
        row.events.map((event) => ({ ...event, at: new Date(event.at) })),
      );
    },
  };
}
