// The DEFAULT driver: a Postgres queue. Zero infra to start — the database you already have
// is the queue. `SELECT ... FOR UPDATE SKIP LOCKED` lets N workers claim disjoint batches
// without a coordinator, and the visibility timeout (`visible_at`) makes a worker crash cost
// one lease instead of one job. The statements themselves live in `driver-pg-sql.ts`, the schema
// they run against in `driver-pg-ddl.ts`, and the row-to-record decoding in `driver-pg-rows.ts`.

import type { Clock } from '@ultimat3/core';
import { systemClock, uuid } from '@ultimat3/core';
import type { BackfillLedger } from './backfill-ledger';
import { nowMs } from './clock';
import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  JobFilter,
  JobIntrospection,
  NackOptions,
  QueueStats,
} from './driver';
import { DEFAULT_QUEUE } from './driver';
import type { BackfillRow, JobRow, StepRow } from './driver-pg-rows';
import { num, toBackfillRun, toJobRecord, toStepRecord } from './driver-pg-rows';
import {
  SQL_ACK,
  SQL_ADVISORY_UNLOCK,
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_PROGRESS,
  SQL_BACKFILL_START,
  SQL_CANCEL,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_FIND_LIVE_BY_KEY,
  SQL_HEARTBEAT,
  SQL_LEASE_ACQUIRE,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_NACK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { DriverUnavailableError, JobDuplicateError } from './errors';
import type { HeldLease, LeaseStore } from './leases';
import type { StepStore } from './steps';

/**
 * The one thing this driver needs from the DB layer, declared structurally so this package can
 * depend on no database package at all.
 *
 * **Not satisfied by `Bun.sql`** — verified against Bun 1.3.14: `Bun.sql.query` is `undefined`.
 * `Bun.sql` is a tagged template whose positional form is `unsafe`, so a `{ executor: Bun.sql }`
 * would `TypeError` on the first claim. What satisfies it is a one-line adapter over a client that
 * already speaks `(text, values)` — `@ultimat3/cli`'s `pgExecutorFor(client)` is the framework's
 * own, wrapping `@ultimat3/db`'s `DbClient.query({ text, values })` — and a `DbTx`, which is a
 * client on the transaction's own connection.
 */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}

export interface PgDriverOptions {
  readonly executor?: PgExecutor;
  readonly clock?: Clock;
}

function resolveExecutor(injected: PgExecutor | undefined): PgExecutor {
  if (injected !== undefined) return injected;
  throw new DriverUnavailableError({
    driver: 'pg',
    // `Bun.sql` is named nowhere in this function and never was: there is no ambient fallback to
    // be "not configured". An executor is injected by the boot or the driver has none.
    cause: 'createPgDriver() was called with no executor, and this driver has no ambient fallback',
    fix: 'set DATABASE_URL in .env so the boot builds one — x db migrate then x dev — or hand this process a queue with no database: setJobDriver(createMemoryDriver())',
  });
}

function pgStepStore(exec: () => PgExecutor): StepStore {
  return {
    async get(runId, name) {
      const rows = await exec().query<StepRow>(SQL_STEP_GET, [runId, name]);
      const row = rows[0];
      return row === undefined ? undefined : toStepRecord(row);
    },
    async put(record) {
      await exec().query(SQL_STEP_PUT, [
        record.runId,
        record.name,
        record.status,
        JSON.stringify(record.output ?? null),
        record.startedAt,
        record.completedAt ?? null,
        record.wakeAt ?? null,
        record.event ?? null,
        record.correlationKey ?? null,
        record.attempts,
        record.error ?? null,
      ]);
    },
    async list(runId) {
      const rows = await exec().query<StepRow>(
        `select * from x_job_steps where run_id = $1 order by started_at`,
        [runId],
      );
      return rows.map(toStepRecord);
    },
    async del(runId, name) {
      await exec().query(`delete from x_job_steps where run_id = $1 and name = $2`, [runId, name]);
    },
    async clear(runId) {
      await exec().query(`delete from x_job_steps where run_id = $1`, [runId]);
    },
  };
}

function pgBackfillLedger(exec: () => PgExecutor): BackfillLedger {
  return {
    async start(run) {
      await exec().query(SQL_BACKFILL_START, [run.runId, run.name, run.checksum, run.appVersion]);
    },
    async progress(runId, at) {
      await exec().query(SQL_BACKFILL_PROGRESS, [runId, at.rows, at.cursor]);
    },
    async finish(runId, at) {
      await exec().query(SQL_BACKFILL_FINISH, [runId, at.status, at.rows]);
    },
    async list(filter = {}) {
      const rows = await exec().query<BackfillRow>(SQL_BACKFILL_LIST, [
        filter.name ?? null,
        filter.status ?? null,
        filter.runId ?? null,
        filter.limit ?? 100,
      ]);
      return rows.map(toBackfillRun);
    },
  };
}

/**
 * Fleet-wide slots over `x_job_leases`. Every decision is ONE statement — the `(lease_key, slot)`
 * primary key is what serialises two workers, so nothing here reads a count and then acts on it.
 */
function pgLeaseStore(exec: () => PgExecutor): LeaseStore {
  return {
    async acquire(key, limit, ttlMs, holder) {
      if (limit <= 0) return undefined;
      const rows = await exec().query<{ slot: number | string }>(SQL_LEASE_ACQUIRE, [
        key,
        holder,
        limit,
        ttlMs,
      ]);
      const row = rows[0];
      return row === undefined ? undefined : { key, slot: Number(row.slot), holder };
    },
    async renew(lease, ttlMs) {
      const rows = await exec().query<{ slot: number | string }>(SQL_LEASE_RENEW, [
        lease.key,
        lease.slot,
        lease.holder,
        ttlMs,
      ]);
      return rows.length > 0;
    },
    async release(lease: HeldLease) {
      await exec().query(SQL_LEASE_RELEASE, [lease.key, lease.slot, lease.holder]);
    },
    async held(key) {
      const rows = await exec().query<{ n: number | string }>(
        `select count(*)::int as n from x_job_leases where lease_key = $1 and expires_at > now()`,
        [key],
      );
      return num(rows[0]?.n);
    },
  };
}

export function createPgDriver(options: PgDriverOptions = {}): JobDriver {
  const clock = options.clock ?? systemClock;
  let executor: PgExecutor | undefined;
  const exec = (): PgExecutor => {
    executor ??= resolveExecutor(options.executor);
    return executor;
  };

  const introspect: JobIntrospection = {
    async job(jobId) {
      const rows = await exec().query<JobRow>(`select * from x_jobs where id = $1`, [jobId]);
      const row = rows[0];
      return row === undefined ? undefined : toJobRecord(row);
    },
    async list(filter: JobFilter = {}) {
      const rows = await exec().query<JobRow>(
        `select * from x_jobs
          where ($1::text is null or queue = $1)
            and ($2::text is null or name  = $2)
            and ($3::text is null or state = $3)
          order by created_at desc
          limit $4`,
        [filter.queue ?? null, filter.name ?? null, filter.state ?? null, filter.limit ?? 100],
      );
      return rows.map(toJobRecord);
    },
    async deadLetters(limit = 100) {
      const rows = await exec().query<JobRow>(
        `select * from x_jobs where state = 'dead' order by updated_at desc limit $1`,
        [limit],
      );
      return rows.map(toJobRecord);
    },
    async requeue(jobId, requeueOptions) {
      if (requeueOptions?.fromStep !== undefined) {
        const current = await this.job(jobId);
        if (current !== undefined) {
          await exec().query(`delete from x_job_steps where run_id = $1 and name = $2`, [
            current.runId,
            requeueOptions.fromStep,
          ]);
        }
      }
      const rows = await exec().query<JobRow>(
        `update x_jobs set state = 'ready', attempt = 0, run_at = now(), updated_at = now()
          where id = $1 returning *`,
        [jobId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new DriverUnavailableError({
          driver: 'pg',
          cause: `job ${jobId} does not exist`,
          fix: 'x jobs ls --state dead --json',
        });
      }
      return toJobRecord(row);
    },
    async cancel(jobId, reason) {
      const rows = await exec().query<JobRow>(SQL_CANCEL, [jobId, reason ?? null]);
      const row = rows[0];
      return row === undefined ? undefined : toJobRecord(row);
    },
  };

  return {
    name: 'pg',
    steps: pgStepStore(exec),
    backfills: pgBackfillLedger(exec),
    leases: pgLeaseStore(exec),
    introspect,

    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const runAt = request.runAt ?? nowMs(clock);
      const rows = await exec().query<{ id: string; run_id: string }>(SQL_ENQUEUE, [
        uuid(),
        request.name,
        request.queue || DEFAULT_QUEUE,
        JSON.stringify(request.input ?? null),
        request.idempotencyKey,
        request.runId ?? uuid(),
        request.maxAttempts,
        runAt,
        request.tenantId ?? null,
        request.traceparent ?? null,
        request.enqueuedBy ?? null,
      ]);
      const inserted = rows[0];
      if (inserted !== undefined) {
        return { id: inserted.id, runId: inserted.run_id, deduped: false };
      }

      // `do nothing` fired: a live job OF THIS NAME, IN THIS TENANT, already owns this idempotency
      // key. Both are in the lookup because both are in the index — without the name this returned
      // whichever other job derived the same natural key; without the tenant it returned another
      // TENANT's row, so the caller's work silently never ran AND the caller was handed an id it
      // has no right to, on a surface (`cancel`) that takes an id with no tenant predicate.
      const existing = await exec().query<{ id: string; run_id: string }>(SQL_FIND_LIVE_BY_KEY, [
        request.name,
        request.idempotencyKey,
        request.tenantId ?? null,
      ]);
      const found = existing[0];
      if (found === undefined) {
        throw new DriverUnavailableError({
          driver: 'pg',
          cause: `enqueue of "${request.name}" was rejected but no live row holds its idempotency key`,
          fix: 'x db migrate   # reapplies SQL_JOBS_TABLE, whose x_jobs_name_tenant_idempotency_live_idx is what this lookup reads',
        });
      }
      if (request.onConflict === 'error') {
        throw new JobDuplicateError({
          job: request.name,
          idempotencyKey: request.idempotencyKey,
          existingId: found.id,
        });
      }
      return { id: found.id, runId: found.run_id, deduped: true };
    },

    async claim(claimOptions: ClaimOptions): Promise<readonly ClaimedJob[]> {
      const queues = claimOptions.queues.length > 0 ? claimOptions.queues : [DEFAULT_QUEUE];
      const rows = await exec().query<JobRow>(SQL_CLAIM, [
        queues,
        claimOptions.limit,
        claimOptions.workerId,
        claimOptions.visibilityTimeoutMs,
      ]);
      const at = nowMs(clock);
      return rows.map((row) => {
        const record = toJobRecord(row);
        return {
          ...record,
          claimedAt: at,
          visibleAt: record.visibleAt ?? at + claimOptions.visibilityTimeoutMs,
        };
      });
    },

    async ack(jobId: string): Promise<void> {
      await exec().query(SQL_ACK, [jobId]);
    },

    async nack(jobId: string, nackOptions: NackOptions): Promise<void> {
      const counts = nackOptions.countsAsAttempt !== false;
      // The same three-way the memory driver takes, and it reads `park` rather than `counts`: the
      // attempt counter and the ready bucket are two facts, and a shed only ever meant the first.
      const state =
        nackOptions.deadLetter === true
          ? 'dead'
          : nackOptions.park === true
            ? 'suspended'
            : 'ready';
      await exec().query(SQL_NACK, [
        jobId,
        state,
        counts,
        nackOptions.delayMs,
        nackOptions.error ?? null,
      ]);
    },

    async heartbeat(jobId: string, heartbeatOptions: HeartbeatOptions): Promise<boolean> {
      const rows = await exec().query<{ id: string }>(SQL_HEARTBEAT, [
        jobId,
        heartbeatOptions.visibilityTimeoutMs,
        heartbeatOptions.workerId ?? null,
      ]);
      // No row means the job is no longer ours: cancelled from outside, or re-claimed after this
      // lease lapsed. Either way the caller has to stop running it.
      return rows.length > 0;
    },

    async stats(): Promise<readonly QueueStats[]> {
      const rows = await exec().query<{
        queue: string;
        ready: number | string;
        delayed: number | string;
        running: number | string;
        suspended: number | string;
        dead: number | string;
        oldest_ready_ms: number | string;
      }>(SQL_STATS, []);
      return rows.map((row) => ({
        queue: row.queue,
        ready: num(row.ready),
        delayed: num(row.delayed),
        running: num(row.running),
        suspended: num(row.suspended),
        dead: num(row.dead),
        oldestReadyMs: Math.round(num(row.oldest_ready_ms)),
      }));
    },
  };
}

/**
 * Advisory-lock leader election. **Correct only on a DEDICATED connection.**
 *
 * `pg_try_advisory_lock` takes a SESSION-level lock, and a session is a connection: hand this a
 * pooled executor and the lock is released the instant that connection goes back to the pool, so
 * every node reads itself as leader and a rolling restart double-fires every task. Postgres also
 * refcounts the lock per acquisition, so a second `acquire()` on a session that already holds the
 * key would need a second `release()` — hence the `held` guard below, which makes repeated
 * `acquire()` calls (the scheduler renews every round) a no-op rather than a leak.
 *
 * `@ultimat3/realtime`'s `PgAdvisoryLock` is the shape that gets this right: it opens a connection
 * of its own and *is* the lock. This package holds no wire protocol, so the executor it is handed
 * is whatever boot built — which is a pool. **Use `createPgLeaseLeader` instead** unless you can
 * prove the executor is a single dedicated session.
 */
export function createPgLeader(
  lockKey: number,
  options: PgDriverOptions = {},
): { acquire(): Promise<boolean>; release(): Promise<void> } {
  const exec = (): PgExecutor => resolveExecutor(options.executor);
  let held = false;
  return {
    async acquire() {
      if (held) return true;
      const rows = await exec().query<{ locked: boolean }>(SQL_TRY_ADVISORY_LOCK, [lockKey]);
      held = rows[0]?.locked === true;
      return held;
    },
    async release() {
      if (!held) return;
      held = false;
      await exec().query(SQL_ADVISORY_UNLOCK, [lockKey]);
    },
  };
}
