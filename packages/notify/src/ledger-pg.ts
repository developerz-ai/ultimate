// The shared delivery ledger: one Postgres table, `insert … on conflict` for the atomicity.
// Without it `replicas: 3` means a job replayed on another node sends a second copy of the same
// notification — the claim this replica took lives in its own heap and nowhere else.
//
// Statements are spelled out so an agent can run the exact one it saw in a log.

import { finiteCount } from '@ultimat3/core';
import type { PgExecutor } from '@ultimat3/jobs';
import type { DeliveryClaim, DeliveryLedger, DeliveryRecord, DeliveryStatus } from './ledger';
import { isDeliveryStatus } from './ledger';

/**
 * Applied the way `SQL_JOBS_TABLE` and `SQL_IDEMPOTENCY_TABLE` are — by the boot, not by an app
 * migration. `create table if not exists` is a no-op against a database that already has it, so a
 * new column is added by `alter table … add column if not exists` and never by editing the
 * `create`.
 *
 * The unique key is an EXPRESSION index over `coalesce(recipient, '')` rather than a plain
 * four-column one. A bulk channel's claim covers the whole audience and so stores a NULL
 * recipient; NULLs are distinct in a unique index on every Postgres before 15, which would let
 * one bulk send be claimed an unbounded number of times. The stored value stays a true NULL —
 * only the index reads it as `''`.
 */
export const SQL_NOTIFY_DELIVERIES_TABLE = `
create table if not exists x_notify_deliveries (
  notifier   text        not null,
  key        text        not null,
  recipient  text,
  channel    text        not null,
  status     text        not null default 'sending',
  attempts   integer     not null default 1,
  at         timestamptz not null default now()
);

create unique index if not exists x_notify_deliveries_claim_idx
  on x_notify_deliveries (notifier, key, channel, coalesce(recipient, ''));

create index if not exists x_notify_deliveries_at_idx on x_notify_deliveries (at);
`;

/**
 * The claim, atomic in one statement. The `do update` fires ONLY for a row that is not already
 * `sent`, so a returned row always means this caller owns the delivery and must send. No row back
 * means the notification already went out and this attempt is a replay.
 */
export const SQL_NOTIFY_CLAIM = `
insert into x_notify_deliveries (notifier, key, recipient, channel, status, attempts, at)
values ($1, $2, $3, $4, 'sending', 1, $5)
on conflict (notifier, key, channel, coalesce(recipient, ''))
do update set attempts = x_notify_deliveries.attempts + 1, status = 'sending', at = excluded.at
where x_notify_deliveries.status <> 'sent'
returning attempts
`;

export const SQL_NOTIFY_SETTLE = `
update x_notify_deliveries set status = $5, at = $6
where notifier = $1 and key = $2 and channel = $4 and coalesce(recipient, '') = coalesce($3, '')
`;

export const SQL_NOTIFY_FIND = `
select notifier, key, recipient, channel, status, attempts, at
from x_notify_deliveries
where notifier = $1 and key = $2 and channel = $4 and coalesce(recipient, '') = coalesce($3, '')
`;

interface DeliveryRow {
  readonly notifier: string;
  readonly key: string;
  readonly recipient: string | null;
  readonly channel: string;
  readonly status: string;
  readonly attempts: number;
  readonly at: Date | string;
}

/** Positional in the order every statement above declares, so the four share one builder. */
const argsOf = (claim: DeliveryClaim): readonly unknown[] => [
  claim.notifier,
  claim.key,
  claim.recipient,
  claim.channel,
];

/**
 * Delete every claim older than the window, and answer how many. `at` is the claim's own
 * timestamp and `SQL_NOTIFY_SETTLE` moves it, so a row ages from its LAST attempt rather than its
 * first — a delivery still being retried is never swept out from under the retry.
 *
 * Unconditional on status, deliberately. A `sending` row past the window belonged to a process
 * that died and never came back; keeping it forever protects nothing, because a re-claim is
 * already allowed on it (see `DeliveryLedger.claim`).
 */
export const SQL_NOTIFY_DELIVERIES_PURGE = `
delete from x_notify_deliveries where at < $1
`;

/**
 * The statement the store actually runs. A bare `delete` answers NO ROWS through `PgExecutor`, so
 * a count read off it is zero forever — a sweep that reports it deleted nothing while deleting
 * everything, which is indistinguishable in a log from a sweep that is not wired at all.
 * `SQL_IDEMPOTENCY_PURGE` is spliced the same way for the same reason.
 */
const SQL_NOTIFY_DELIVERIES_PURGE_COUNTED = `${SQL_NOTIFY_DELIVERIES_PURGE} returning key`;

export interface PgDeliveryLedgerOptions {
  readonly executor: PgExecutor;
  /**
   * How long a settled claim is kept. Defaults to `DEFAULT_DELIVERY_WINDOW_MS`.
   *
   * NEVER SHORTER THAN YOUR IDEMPOTENCY WINDOW, and this is the one dangerous direction: a job
   * replayed inside the idempotency window, against a delivery claim that has already been
   * purged, claims cleanly and sends the notification a second time. `createPgDeliveryLedger({
   * executor, windowMs: idempotency.windowMs })` makes that impossible by construction rather
   * than by two defaults that happen to agree.
   */
  readonly windowMs?: number | undefined;
}

/** 24 hours — the same default `postgresIdempotencyStore` carries, for the reason above. */
export const DEFAULT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The Postgres ledger's own wider type. `purgeExpired` is HERE and not on `DeliveryLedger`
 * because a heap map bounded by process life has nothing to delete, and adding a method to the
 * seam every implementation must satisfy is a breaking change for an app that wrote its own.
 * Exactly the shape `PostgresIdempotencyStore` already has.
 */
export interface PgDeliveryLedger extends DeliveryLedger {
  readonly windowMs: number;
  purgeExpired(nowMs: number): Promise<number>;
}

export function createPgDeliveryLedger(options: PgDeliveryLedgerOptions): PgDeliveryLedger {
  const { executor } = options;
  const windowMs = finiteCount(
    'createPgDeliveryLedger',
    'windowMs',
    options.windowMs ?? DEFAULT_DELIVERY_WINDOW_MS,
    1,
  );
  return {
    windowMs,
    async purgeExpired(nowMs) {
      // The JOB's clock, not the server's, and the same rule `x_rate_limit`'s target states: `at`
      // is written by whichever process took the delivery, so a cutoff computed from `now()` in
      // Postgres measures the offset between two clocks instead of the age of the row.
      const before = new Date(finiteCount('purgeExpired', 'nowMs', nowMs, 0) - windowMs);
      const rows = await executor.query<{ key: string }>(SQL_NOTIFY_DELIVERIES_PURGE_COUNTED, [
        before,
      ]);
      return rows.length;
    },
    async claim(claim, at) {
      const rows = await executor.query<{ attempts: number }>(SQL_NOTIFY_CLAIM, [
        ...argsOf(claim),
        at,
      ]);
      return rows.length > 0;
    },
    async settle(claim, status, at) {
      await executor.query(SQL_NOTIFY_SETTLE, [...argsOf(claim), status, at]);
    },
    async find(claim) {
      const rows = await executor.query<DeliveryRow>(SQL_NOTIFY_FIND, argsOf(claim));
      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    },
  };
}

/**
 * A status column this package did not write — a hand-edited row, or a column an older version
 * wrote — reads as `failed` rather than being cast through. Casting would let an unknown string
 * flow out as a `DeliveryStatus` the type says it cannot be; `failed` is the safe reading, because
 * only `sent` suppresses a resend and nothing else may be allowed to imply it.
 */
const toRecord = (row: DeliveryRow): DeliveryRecord => ({
  notifier: row.notifier,
  key: row.key,
  recipient: row.recipient,
  channel: row.channel,
  status: (isDeliveryStatus(row.status) ? row.status : 'failed') satisfies DeliveryStatus,
  attempts: row.attempts,
  at: row.at instanceof Date ? row.at : new Date(row.at),
});
