// The shared in-app inbox: one Postgres table, applied by the boot the way `x_jobs` is.
// Statements are spelled out so an agent can run the exact one it saw in a log.

import { finiteCount, uuid } from '@ultimat3/core';
import type { PgExecutor } from '@ultimat3/jobs';
import type { InboxRow, InboxStore, InboxWrite } from './inbox';
import { DEFAULT_INBOX_PAGE } from './inbox';

/**
 * `unique (recipient, notifier, key)` is what makes `add` idempotent, and it is the same identity
 * the delivery ledger claims on — one notification, one row, however many times the job replays.
 *
 * The unread badge wants a PARTIAL index on `read_at is null`, which is the query that runs on
 * every page load. It is spelled out here because this table is DDL rather than an `entity()`
 * declaration, so nothing has to work around the invariant DSL's missing null predicate.
 */
export const SQL_NOTIFY_INBOX_TABLE = `
create table if not exists x_notify_inbox (
  id         uuid        primary key,
  recipient  text        not null,
  notifier   text        not null,
  key        text        not null,
  params     jsonb       not null,
  created_at timestamptz not null default now(),
  seen_at    timestamptz,
  read_at    timestamptz,
  unique (recipient, notifier, key)
);

create index if not exists x_notify_inbox_page_idx
  on x_notify_inbox (recipient, created_at desc, id);

create index if not exists x_notify_inbox_unread_idx
  on x_notify_inbox (recipient) where read_at is null;
`;

const COLUMNS = 'id, recipient, notifier, key, params, created_at, seen_at, read_at';

/**
 * Convergent: a second write of the same notification returns the FIRST row rather than moving
 * its timestamps, so replaying the job leaves a message the user already read still read.
 */
export const SQL_NOTIFY_INBOX_ADD = `
with inserted as (
  insert into x_notify_inbox (id, recipient, notifier, key, params, created_at)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (recipient, notifier, key) do nothing
  returning ${COLUMNS}
)
select ${COLUMNS} from inserted
union all
select ${COLUMNS} from x_notify_inbox
where recipient = $2 and notifier = $3 and key = $4
  and not exists (select 1 from inserted)
`;

/** Newest first, `(created_at desc, id)` — the tail key is unique, so the order is total and a
 * bounded page cannot drop or repeat a row when two notifications land in the same millisecond. */
export const SQL_NOTIFY_INBOX_PAGE = `
select ${COLUMNS} from x_notify_inbox
where recipient = $1 and ($2::boolean is not true or read_at is null)
order by created_at desc, id
limit $3
`;

export const SQL_NOTIFY_INBOX_UNREAD = `
select count(*)::int as unread from x_notify_inbox where recipient = $1 and read_at is null
`;

/** Scoped by recipient, so an id somebody else named is not found and not written. */
export const SQL_NOTIFY_INBOX_MARK_READ = `
update x_notify_inbox set read_at = $3
where recipient = $1 and id = any($2::uuid[]) and read_at is null
returning id
`;

/**
 * Both windows in ONE statement, and each half is inert when its window is absent: a `null`
 * cutoff makes its `is not null` guard false, so the other half runs alone. One round trip, and
 * — more importantly — no way to express "purge read rows" and "purge unread rows" as two
 * statements that could disagree about which rows are which.
 *
 * A READ row ages from `read_at` and an UNREAD one from `created_at`. Ageing a read row from
 * `created_at` would delete a notification the moment the recipient opened it, if it happened to
 * be old — which is the opposite of what a read window means.
 */
export const SQL_NOTIFY_INBOX_PURGE = `
delete from x_notify_inbox
where ($1::timestamptz is not null and read_at is not null and read_at < $1)
   or ($2::timestamptz is not null and read_at is null and created_at < $2)
returning id
`;

export const SQL_NOTIFY_INBOX_MARK_SEEN = `
update x_notify_inbox set seen_at = $2 where recipient = $1 and seen_at is null returning id
`;

interface InboxDbRow {
  readonly id: string;
  readonly recipient: string;
  readonly notifier: string;
  readonly key: string;
  readonly params: unknown;
  readonly created_at: Date | string;
  readonly seen_at: Date | string | null;
  readonly read_at: Date | string | null;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const toRow = (row: InboxDbRow): InboxRow => ({
  id: row.id,
  recipient: row.recipient,
  notifier: row.notifier,
  key: row.key,
  params: row.params,
  createdAt: asDate(row.created_at),
  seenAt: row.seen_at === null ? null : asDate(row.seen_at),
  readAt: row.read_at === null ? null : asDate(row.read_at),
});

export interface PgInboxStoreOptions {
  readonly executor: PgExecutor;
  /**
   * Ids for new rows. A `random = Math.random` default parameter is this repo's injectable seam
   * and this is the same shape: a test that needs a fixed id passes one, and shipped source never
   * calls a die it cannot control.
   */
  readonly newId?: () => string;
}

/**
 * The two cutoffs, each `undefined` where its window is unset. Never a single window: the axiom-8
 * objection to sweeping an inbox is only about UNREAD messages, so the two have to be separately
 * expressible or an app that wants read notices gone in a month is forced to choose between
 * deleting unread ones too and sweeping nothing.
 */
export interface InboxPurgeBefore {
  readonly read?: Date | undefined;
  readonly unread?: Date | undefined;
}

/**
 * The Postgres inbox's own wider type. `purgeBefore` is HERE and not on `InboxStore` for the
 * reason `PgDeliveryLedger.purgeExpired` is not on `DeliveryLedger`: adding a method to the seam
 * every implementation must satisfy is a breaking change for an app that wrote its own.
 */
export interface PgInboxStore extends InboxStore {
  purgeBefore(before: InboxPurgeBefore): Promise<number>;
}

export function createPgInboxStore(options: PgInboxStoreOptions): PgInboxStore {
  const { executor } = options;
  const newId = options.newId ?? uuid;
  return {
    async add(write: InboxWrite) {
      const rows = await executor.query<InboxDbRow>(SQL_NOTIFY_INBOX_ADD, [
        newId(),
        write.recipient,
        write.notifier,
        write.key,
        JSON.stringify(write.params),
        write.createdAt,
      ]);
      const row = rows[0];
      // The statement's `union all` always answers exactly one row — the inserted one, or the
      // existing one it conflicted with. Nothing back means the row was deleted between the two
      // halves, which is a race no caller can repair, so it reads as the write that just happened.
      return row === undefined ? { id: newId(), ...write, seenAt: null, readAt: null } : toRow(row);
    },
    async list(query) {
      // Screened here and not left to Postgres: this number is bound straight into `limit $3`, and
      // what a driver does with a `NaN` parameter is the driver's business — the memory store beside
      // it answered `[]` for the same input. `??` cannot see it, because `NaN` is not nullish.
      const limit = finiteCount(
        'createPgInboxStore',
        'limit',
        query.limit ?? DEFAULT_INBOX_PAGE,
        0,
      );
      const rows = await executor.query<InboxDbRow>(SQL_NOTIFY_INBOX_PAGE, [
        query.recipient,
        query.unreadOnly === true,
        limit,
      ]);
      return rows.map(toRow);
    },
    async unreadCount(recipient) {
      const rows = await executor.query<{ unread: number }>(SQL_NOTIFY_INBOX_UNREAD, [recipient]);
      return rows[0]?.unread ?? 0;
    },
    async markRead(input) {
      const rows = await executor.query<{ id: string }>(SQL_NOTIFY_INBOX_MARK_READ, [
        input.recipient,
        [...input.ids],
        input.at,
      ]);
      return rows.length;
    },
    async purgeBefore(before) {
      // Neither window set is not an error and not a no-op to leave to Postgres: the statement
      // would run, match nothing and cost a scan on every hourly sweep of every app that never
      // configured retention, which is every app by default.
      if (before.read === undefined && before.unread === undefined) return 0;
      const rows = await executor.query<{ id: string }>(SQL_NOTIFY_INBOX_PURGE, [
        before.read ?? null,
        before.unread ?? null,
      ]);
      return rows.length;
    },
    async markSeen(input) {
      const rows = await executor.query<{ id: string }>(SQL_NOTIFY_INBOX_MARK_SEEN, [
        input.recipient,
        input.at,
      ]);
      return rows.length;
    },
  };
}
