// The `x_outbox` implementation of `OutboxStore` — the half of the transactional outbox that
// makes it transactional. `stage()` runs on the CALLER'S OWN connection, so the queue row is in
// the same Postgres transaction as the business rows and commits or vanishes with them. The
// memory store hangs rows off the `Tx` object and is correct only inside one process; this is
// what a deployment installs.
//
// `txExecutor` is injected rather than resolved here for the reason `createPgDriver` takes a
// `PgExecutor`: this package holds no `@ultimat3/db` dependency, and "which connection is this
// `Tx` on" is a question only boot can answer. Boot has `currentTx()` — a `DbTx` IS a client on
// the transaction's connection — so the wiring is one line there and no tier crossing here.

import type { Clock } from '@ultimat3/core';
import { uuid } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { nowMs } from './clock';
import type { PgExecutor } from './driver-pg';
import {
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_PENDING_COUNT,
  SQL_OUTBOX_RELEASE,
  SQL_OUTBOX_STAGE,
} from './driver-pg-sql';
import type { OutboxRecord, OutboxStore } from './outbox';
import { DEFAULT_OUTBOX_CLAIM_LEASE_MS } from './outbox';

interface OutboxRow {
  readonly id: string;
  readonly job: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotency_key: string;
  readonly max_attempts: number;
  readonly run_at: number | string;
  readonly staged_at: number | string;
  readonly tenant_id: string | null;
  readonly traceparent: string | null;
  readonly enqueued_by: string | null;
}

export interface PgOutboxOptions {
  /**
   * The pooled executor the RELAY uses: `claim`, `markPublished` and `pendingCount` all run after
   * the caller's transaction is gone, so they must not be bound to it.
   */
  readonly executor: PgExecutor;
  /**
   * The executor bound to `tx`'s own connection. Boot supplies it; without it `stage()` would
   * write on a second connection and the outbox would guarantee nothing at all.
   */
  readonly txExecutor: (tx: Tx) => PgExecutor;
  readonly clock?: Clock;
  /**
   * How long a claimed row stays this relay's before any relay may take it again. It bounds one
   * thing only: how long the rows of a relay that DIED mid-batch sit unpublished. A pass that is
   * merely slow keeps its rows because it published them; a pass that failed hands them back
   * through `release`.
   */
  readonly claimLeaseMs?: number;
  /** Written to `claimed_by`. Diagnostics — which relay is sitting on a batch. */
  readonly relayId?: string;
}

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    job: row.job,
    queue: row.queue,
    input: row.input,
    idempotencyKey: row.idempotency_key,
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    stagedAt: Number(row.staged_at),
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    ...(row.enqueued_by === null ? {} : { enqueuedBy: row.enqueued_by }),
  };
}

export function createPgOutboxStore(options: PgOutboxOptions): OutboxStore {
  // What each open transaction has staged, for `commit()`'s return value only. Never the source
  // of truth — that is the row, and the row's fate is the transaction's. A WeakMap so a `Tx` that
  // is neither committed nor rolled back (a process killed mid-request) leaves nothing behind.
  const staged = new WeakMap<object, OutboxRecord[]>();
  const key = (tx: Tx): object => tx as unknown as object;
  // One id per store, minted here rather than per claim: `claimed_by` is read by an operator
  // asking which relay is sitting on a batch, and a value that changed every tick answers nobody.
  const relayId = options.relayId ?? `relay-${uuid()}`;

  return {
    async stage(tx, record) {
      await options
        .txExecutor(tx)
        .query(SQL_OUTBOX_STAGE, [
          record.id,
          record.job,
          record.queue,
          JSON.stringify(record.input ?? null),
          record.idempotencyKey,
          record.maxAttempts,
          record.runAt,
          record.stagedAt,
          record.tenantId ?? null,
          record.traceparent ?? null,
          record.enqueuedBy ?? null,
        ]);
      const bucket = staged.get(key(tx)) ?? [];
      bucket.push(record);
      staged.set(key(tx), bucket);
    },

    /**
     * Nothing to do but report. The rows became visible when Postgres committed them — there is
     * no second write here, and that absence IS the guarantee: a commit hook that had to run
     * would be one more thing between the business rows and the job row.
     */
    commit(tx) {
      const bucket = staged.get(key(tx)) ?? [];
      staged.delete(key(tx));
      return Promise.resolve(bucket);
    },

    /** Also nothing: the ROLLBACK already took the rows. Only the bookkeeping is ours to drop. */
    rollback(tx) {
      staged.delete(key(tx));
      return Promise.resolve();
    },

    /**
     * A CLAIM, not a read. `for update skip locked` in a bare select held its locks only for that
     * statement — which under autocommit is over before this method resolves — so two relays
     * polling 200ms apart got the identical batch and both published it. The idempotency key
     * collapses that only while the first job is still live, so the repeat that lands after it
     * finished runs the handler a second time. `SQL_OUTBOX_CLAIM` stamps `claimed_at` in the same
     * statement that locks the row; `skip locked` still keeps two relays from serialising.
     */
    async claim(limit) {
      const rows = await options.executor.query<OutboxRow>(SQL_OUTBOX_CLAIM, [
        limit,
        options.claimLeaseMs ?? DEFAULT_OUTBOX_CLAIM_LEASE_MS,
        relayId,
      ]);
      return rows.map(toRecord);
    },

    async release(ids) {
      if (ids.length === 0) return;
      await options.executor.query(SQL_OUTBOX_RELEASE, [ids]);
    },

    async markPublished(id, at) {
      await options.executor.query(SQL_OUTBOX_MARK_PUBLISHED, [id, at || nowMs(options.clock)]);
    },

    async pendingCount() {
      const rows = await options.executor.query<{ pending: number | string }>(
        SQL_OUTBOX_PENDING_COUNT,
        [],
      );
      return Number(rows[0]?.pending ?? 0);
    },
  };
}
