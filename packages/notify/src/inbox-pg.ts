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

export function createPgInboxStore(options: PgInboxStoreOptions): InboxStore {
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
    async markSeen(input) {
      const rows = await executor.query<{ id: string }>(SQL_NOTIFY_INBOX_MARK_SEEN, [
        input.recipient,
        input.at,
      ]);
      return rows.length;
    },
  };
}
