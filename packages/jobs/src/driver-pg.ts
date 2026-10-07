// The DEFAULT driver: a Postgres queue. Zero infra to start — the database you already have
// is the queue. `SELECT ... FOR UPDATE SKIP LOCKED` lets N workers claim disjoint batches
// without a coordinator, and the visibility timeout (`visible_at`) makes a worker crash cost
// one lease instead of one job. The statements themselves live in `driver-pg-sql.ts`, the schema
// they run against in `driver-pg-ddl.ts`, and the row-to-record decoding in `driver-pg-rows.ts`.

import type { Clock, PgExecutor } from '@ultimat3/core';
import { finiteCount, renderCauseValue, systemClock, uuidV7 } from '@ultimat3/core';
import type { BackfillLedger } from './backfill-ledger';
import { listedRunId } from './backfill-ledger';
import { nowMs } from './clock';
import { nackOutcome } from './counters';
import type {
  AckOptions,
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  JobRecord,
  NackOptions,
  QueueStats,
} from './driver';
import {
  assertClaimBounds,
  assertClaimQueues,
  DEFAULT_QUEUE,
  nackState,
  REQUEUEABLE_STATES,
} from './driver';
import { pgOperator } from './driver-pg-operator';
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
  SQL_JOB_DEAD_LETTERS,
  SQL_JOB_GET,
  SQL_JOB_LIVE_HOLDER,
  SQL_JOB_REQUEUE,
  SQL_LEASE_ACQUIRE,
  SQL_LEASE_HOLDERS,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_NACK,
  SQL_OUTBOX_PUBLISHED_JOB,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_LIST,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { DriverUnavailableError, JobDuplicateError, LeaseLostError } from './errors';
import { JobNotFoundError, JobNotRequeueableError, requeueKeyTaken } from './errors-requeue';
import type { JobIntrospection } from './introspection';
import { MAX_ERROR_STACK_LENGTH } from './introspection';
import type { HeldLease, LeaseStore } from './leases';
import type { StepStore } from './steps';

/** How often `enqueue` sends its insert before it calls a refusal an index fault, not a race. */
const ENQUEUE_ATTEMPTS = 2;

export interface PostgresJobDriverOptions {
  readonly executor?: PgExecutor;
  readonly clock?: Clock;
}

function resolveExecutor(injected: PgExecutor | undefined): PgExecutor {
  if (injected !== undefined) return injected;
  throw new DriverUnavailableError({
    driver: 'pg',
    // `Bun.sql` is named nowhere in this function and never was: there is no ambient fallback to
    // be "not configured". An executor is injected by the boot or the driver has none.
    cause:
      'postgresJobDriver() was called with no executor, and this driver has no ambient fallback',
    fix: 'set DATABASE_URL in .env so the boot builds one — x db migrate then x dev — or hand this process a queue with no database: setJobDriver(memoryJobDriver())',
  });
}

function postgresStepStore(exec: () => PgExecutor): StepStore {
  return {
    async get(runId, name) {
      const rows = await exec().query<StepRow>(SQL_STEP_GET, [runId, name]);
      const row = rows[0];
      return row === undefined ? undefined : toStepRecord(row);
    },
    async put(record, by) {
      const written = await exec().query(SQL_STEP_PUT, [
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
        by?.jobId ?? null,
        by?.workerId ?? null,
        by?.claim ?? null,
      ]);
      // No row back is the fence refusing: the claim this write was made under is gone.
      if (by !== undefined && written.length === 0) {
        throw new LeaseLostError({ job: by.job, jobId: by.jobId });
      }
    },
    async list(runId) {
      const rows = await exec().query<StepRow>(SQL_STEP_LIST, [runId]);
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

function postgresBackfillLedger(exec: () => PgExecutor): BackfillLedger {
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
      // Before the statement: `$3::uuid` raises a raw 22P02 for anything the screen refuses.
      const runId = listedRunId('the pg ledger', filter.runId);
      const rows = await exec().query<BackfillRow>(SQL_BACKFILL_LIST, [
        filter.name ?? null,
        filter.status ?? null,
        runId ?? null,
        finiteCount('the pg driver list', 'limit', filter.limit ?? 100),
      ]);
      return rows.map(toBackfillRun);
    },
  };
}

/**
 * Fleet-wide slots over `x_job_leases`. Every decision is ONE statement — the `(lease_key, slot)`
 * primary key is what serialises two workers, so nothing here reads a count and then acts on it.
 */
function postgresLeaseStore(exec: () => PgExecutor): LeaseStore {
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
    async holders(key) {
      const rows = await exec().query<{ holder: string }>(SQL_LEASE_HOLDERS, [key]);
      return rows.map((row) => row.holder);
    },
  };
}

export function postgresJobDriver(options: PostgresJobDriverOptions = {}): JobDriver {
  const clock = options.clock ?? systemClock;
  let executor: PgExecutor | undefined;
  const exec = (): PgExecutor => {
    executor ??= resolveExecutor(options.executor);
    return executor;
  };

  const job = async (jobId: string): Promise<JobRecord | undefined> => {
    const rows = await exec().query<JobRow>(SQL_JOB_GET, [jobId]);
    const row = rows[0];
    return row === undefined ? undefined : toJobRecord(row);
  };

  const introspect: JobIntrospection = {
    job,
    ...pgOperator(exec, job),
    async deadLetters(limit = 100) {
      const rows = await exec().query<JobRow>(SQL_JOB_DEAD_LETTERS, [
        finiteCount('the pg driver dead letters', 'limit', limit),
      ]);
      return rows.map(toJobRecord);
    },
    async requeue(jobId, requeueOptions) {
      const current = await job(jobId);
      // The one answer both drivers give an id nobody queued — it was `X_DRIVER_UNAVAILABLE`
      // here, from a driver that was answering perfectly well.
      if (current === undefined) throw new JobNotFoundError({ jobId, driver: 'pg' });
      // Both refusals BEFORE anything is deleted or updated — a refused requeue changes nothing.
      if (!REQUEUEABLE_STATES.has(current.state)) {
        throw new JobNotRequeueableError({ jobId, state: current.state });
      }
      const holders = await exec().query<{ id: string }>(SQL_JOB_LIVE_HOLDER, [
        current.name,
        current.tenantId ?? null,
        current.idempotencyKey,
        jobId,
      ]);
      const holder = holders[0];
      if (holder !== undefined) throw requeueKeyTaken({ ...current, holderId: holder.id });
      // ONE statement moves the row and drops its steps: nothing is deleted for a requeue that
      // did not land.
      const rows = await exec().query<JobRow>(SQL_JOB_REQUEUE, [
        jobId,
        requeueOptions?.fromStep ?? null,
      ]);
      const row = rows[0];
      // Read as finished a moment ago and live now: another requeue won the race.
      if (row === undefined) throw new JobNotRequeueableError({ jobId, state: 'live' });
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
    steps: postgresStepStore(exec),
    backfills: postgresBackfillLedger(exec),
    leases: postgresLeaseStore(exec),
    introspect,

    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      const runAt = request.runAt ?? nowMs(clock);
      const params = [
        request.id ?? uuidV7(),
        request.name,
        request.queue || DEFAULT_QUEUE,
        JSON.stringify(request.input ?? null),
        request.idempotencyKey,
        request.runId ?? uuidV7(),
        request.maxAttempts,
        runAt,
        request.tenantId ?? null,
        request.traceparent ?? null,
        request.enqueuedBy ?? null,
      ];
      // TWICE at most. The insert and the lookup below are two statements, and the live holder
      // of the key can settle between them: the insert met it, the lookup did not. That is a key
      // that just came free, so the insert is sent once more and lands. A second miss is not a
      // race any more — see the refusal.
      for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
        const rows = await exec().query<{ id: string; run_id: string }>(SQL_ENQUEUE, params);
        const inserted = rows[0];
        if (inserted !== undefined) {
          return { id: inserted.id, runId: inserted.run_id, deduped: false };
        }

        // Nothing inserted under an id the CALLER allocated: the outbox publishing one staged row
        // a second time. The job its first publish made is the answer, whatever state it reached.
        if (request.id !== undefined) {
          const published = await exec().query<{ id: string; run_id: string }>(
            SQL_OUTBOX_PUBLISHED_JOB,
            [request.id],
          );
          const made = published[0];
          if (made !== undefined) return { id: made.id, runId: made.run_id, deduped: true };
        }

        // `do nothing` fired: a live job OF THIS NAME, IN THIS TENANT, already owns this
        // idempotency key. Both are in the lookup because both are in the index — without the
        // name this returned whichever other job derived the same natural key; without the tenant
        // it returned another TENANT's row, so the caller's work silently never ran AND the caller
        // was handed an id it has no right to, on a surface (`cancel`) that takes an id with no
        // tenant predicate.
        const existing = await exec().query<{ id: string; run_id: string }>(SQL_FIND_LIVE_BY_KEY, [
          request.name,
          request.idempotencyKey,
          request.tenantId ?? null,
        ]);
        const found = existing[0];
        if (found === undefined) continue;
        if (request.onConflict === 'error') {
          throw new JobDuplicateError({
            job: request.name,
            idempotencyKey: request.idempotencyKey,
            existingId: found.id,
          });
        }
        return { id: found.id, runId: found.run_id, deduped: true };
      }
      throw new DriverUnavailableError({
        driver: 'pg',
        cause: `enqueue of ${renderCauseValue(request.name)} was rejected ${ENQUEUE_ATTEMPTS} times running and no live row holds its idempotency key either time — one miss is a holder that settled between the insert and the lookup, and is retried; two is an index the lookup does not agree with, and x db migrate reapplies SQL_JOBS_TABLE, whose x_jobs_name_tenant_idempotency_live_idx is what the lookup reads`,
        fix: 'x db migrate',
      });
    },

    async claim(claimOptions: ClaimOptions): Promise<readonly ClaimedJob[]> {
      assertClaimQueues('pg', claimOptions);
      assertClaimBounds('pg', claimOptions);
      const rows = await exec().query<JobRow>(SQL_CLAIM, [
        claimOptions.queues,
        claimOptions.limit,
        claimOptions.workerId,
        claimOptions.visibilityTimeoutMs,
        claimOptions.dropExhausted ?? [],
      ]);
      const at = nowMs(clock);
      // Both arms of the statement answer, told apart by the state each wrote: `running` is a
      // claim, `dead` a row the claim buried — reported, never handed out as work.
      const records = rows.map(toJobRecord);
      const buried = records.filter((record) => record.state !== 'running');
      if (buried.length > 0) claimOptions.onExhausted?.(buried);
      return records
        .filter((record) => record.state === 'running')
        .map((record) => ({
          ...record,
          claimedBy: claimOptions.workerId,
          claim: record.claim ?? 0,
          claimedAt: at,
          visibleAt: record.visibleAt ?? at + claimOptions.visibilityTimeoutMs,
        }));
    },

    // Both settles answer whether they LANDED: no row back is a settle from a worker that no
    // longer owns the job (`SQL_ACK` says why both fences exist), and the caller logs it.
    async ack(jobId: string, by: AckOptions): Promise<boolean> {
      const rows = await exec().query<{ name: string }>(SQL_ACK, [
        jobId,
        by.workerId,
        Math.round(by.durationMs ?? 0),
        by.claim,
      ]);
      return rows.length > 0;
    },

    async nack(jobId: string, nackOptions: NackOptions): Promise<boolean> {
      const counts = nackOptions.countsAsAttempt !== false;
      const outcome = nackOutcome(nackOptions);
      // The reading the memory driver takes — `nackState` is the one definition — and it reads
      // `park` rather than `counts`: the attempt counter and the ready bucket are two facts, and a
      // shed only ever meant the first.
      const rows = await exec().query<{ name: string }>(SQL_NACK, [
        jobId,
        nackState(nackOptions),
        counts,
        nackOptions.delayMs,
        nackOptions.error ?? null,
        nackOptions.workerId,
        nackOptions.stack?.slice(0, MAX_ERROR_STACK_LENGTH) ?? null,
        outcome === 'retried' ? 1 : 0,
        outcome === 'failed' ? 1 : 0,
        outcome === 'dead' ? 1 : 0,
        Math.round(nackOptions.durationMs ?? 0),
        nackOptions.claim,
      ]);
      return rows.length > 0;
    },

    async heartbeat(jobId: string, heartbeatOptions: HeartbeatOptions): Promise<boolean> {
      const rows = await exec().query<{ id: string }>(SQL_HEARTBEAT, [
        jobId,
        heartbeatOptions.visibilityTimeoutMs,
        heartbeatOptions.workerId ?? null,
        heartbeatOptions.claim ?? null,
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
        failed: number | string;
        dead: number | string;
        oldest_ready_ms: number | string;
      }>(SQL_STATS, []);
      return rows.map((row) => ({
        queue: row.queue,
        ready: num(row.ready),
        delayed: num(row.delayed),
        running: num(row.running),
        suspended: num(row.suspended),
        failed: num(row.failed),
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
 * `@ultimat3/realtime`'s `postgresAdvisoryLock()` is the shape that gets this right: it opens a connection
 * of its own and *is* the lock. This package holds no wire protocol, so the executor it is handed
 * is whatever boot built — which is a pool. **Use `postgresLeaseLeader` instead** unless you can
 * prove the executor is a single dedicated session.
 */
export function postgresLeader(
  lockKey: number,
  options: PostgresJobDriverOptions = {},
): { acquire(): Promise<boolean>; release(): Promise<void>; readonly renewEveryMs: number } {
  const exec = (): PgExecutor => resolveExecutor(options.executor);
  let held = false;
  return {
    // Asked every time: a held advisory lock answers from the flag below, at no cost.
    renewEveryMs: 0,
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
