// The DEFAULT driver: a Postgres queue. Zero infra to start — the database you already have
// is the queue. `SELECT ... FOR UPDATE SKIP LOCKED` lets N workers claim disjoint batches
// without a coordinator, and the visibility timeout (`visible_at`) makes a worker crash cost
// one lease instead of one job. The statements themselves live in `driver-pg-sql.ts`.

import type { Clock } from '@ultimat3/core';
import { systemClock, uuid } from '@ultimat3/core';
import type { BackfillLedger, BackfillRun, BackfillStatus } from './backfill-ledger';
import { nowMs } from './clock';
import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  JobFilter,
  JobIntrospection,
  JobRecord,
  NackOptions,
  QueueStats,
} from './driver';
import { DEFAULT_QUEUE } from './driver';
import {
  SQL_ACK,
  SQL_ADVISORY_UNLOCK,
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_PROGRESS,
  SQL_BACKFILL_START,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_FIND_LIVE_BY_KEY,
  SQL_HEARTBEAT,
  SQL_NACK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { DriverUnavailableError, JobDuplicateError } from './errors';
import type { StepRecord, StepStore } from './steps';

/** The one thing this driver needs from the DB layer. Satisfied by `Bun.sql` and by a Tx. */
export interface PgExecutor {
  query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]>;
}

export interface PgDriverOptions {
  readonly executor?: PgExecutor;
  readonly clock?: Clock;
}

interface StepRow {
  readonly run_id: string;
  readonly name: string;
  readonly status: string;
  readonly output: unknown;
  readonly started_at: number | string;
  readonly completed_at: number | string | null;
  readonly wake_at: number | string | null;
  readonly event: string | null;
  readonly correlation_key: string | null;
  readonly attempts: number;
  readonly error: string | null;
}

interface BackfillRow {
  readonly run_id: string;
  readonly name: string;
  readonly checksum: string;
  readonly status: string;
  readonly app_version: string;
  readonly rows_processed: number | string;
  readonly last_cursor: string | null;
  readonly started_at: number | string;
  readonly completed_at: number | string | null;
}

interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotency_key: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly state: string;
  readonly tenant_id: string | null;
  readonly last_error: string | null;
  readonly claimed_by: string | null;
  readonly run_at: number | string;
  readonly visible_at: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

const num = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const optionalNum = (value: number | string | null | undefined): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

function toJobRecord(row: JobRow): JobRecord {
  const visibleAt = optionalNum(row.visible_at);
  return {
    id: row.id,
    name: row.name,
    queue: row.queue,
    input: row.input,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    state: row.state as JobRecord['state'],
    runAt: num(row.run_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(visibleAt === undefined ? {} : { visibleAt }),
  };
}

function toStepRecord(row: StepRow): StepRecord {
  const completedAt = optionalNum(row.completed_at);
  const wakeAt = optionalNum(row.wake_at);
  return {
    runId: row.run_id,
    name: row.name,
    status: row.status as StepRecord['status'],
    output: row.output,
    startedAt: num(row.started_at),
    attempts: row.attempts,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(wakeAt === undefined ? {} : { wakeAt }),
    ...(row.event === null ? {} : { event: row.event }),
    ...(row.correlation_key === null ? {} : { correlationKey: row.correlation_key }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function resolveExecutor(injected: PgExecutor | undefined): PgExecutor {
  if (injected !== undefined) return injected;
  throw new DriverUnavailableError({
    driver: 'pg',
    cause: 'no PgExecutor was provided and Bun.sql is not configured',
    fix: 'set DATABASE_URL in .env then run `x db up`, or use driver: "memory" in app.config.ts',
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

function toBackfillRun(row: BackfillRow): BackfillRun {
  const completedAt = optionalNum(row.completed_at);
  return {
    runId: row.run_id,
    name: row.name,
    checksum: row.checksum,
    status: row.status as BackfillStatus,
    appVersion: row.app_version,
    // `rows_processed` is a bigint, which every Postgres client hands back as a string.
    rows: num(row.rows_processed),
    cursor: row.last_cursor,
    startedAt: num(row.started_at),
    ...(completedAt === undefined ? {} : { completedAt }),
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
          fix: 'x jobs list --state dead --json',
        });
      }
      return toJobRecord(row);
    },
  };

  return {
    name: 'pg',
    steps: pgStepStore(exec),
    backfills: pgBackfillLedger(exec),
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
      ]);
      const inserted = rows[0];
      if (inserted !== undefined) {
        return { id: inserted.id, runId: inserted.run_id, deduped: false };
      }

      // `do nothing` fired: a live job already owns this idempotency key.
      const existing = await exec().query<{ id: string; run_id: string }>(SQL_FIND_LIVE_BY_KEY, [
        request.idempotencyKey,
      ]);
      const found = existing[0];
      if (found === undefined) {
        throw new DriverUnavailableError({
          driver: 'pg',
          cause: `enqueue of "${request.name}" was rejected but no live row holds its idempotency key`,
          fix: 'x db check — the x_jobs_idempotency_live_idx index is missing or stale',
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
      const state = nackOptions.deadLetter === true ? 'dead' : counts ? 'ready' : 'suspended';
      await exec().query(SQL_NACK, [
        jobId,
        state,
        counts,
        nackOptions.delayMs,
        nackOptions.error ?? null,
      ]);
    },

    async heartbeat(jobId: string, heartbeatOptions): Promise<void> {
      await exec().query(SQL_HEARTBEAT, [jobId, heartbeatOptions.visibilityTimeoutMs]);
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

/** Advisory-lock leader election, used by the `scheduler` role. */
export function createPgLeader(
  lockKey: number,
  options: PgDriverOptions = {},
): { acquire(): Promise<boolean>; release(): Promise<void> } {
  const exec = (): PgExecutor => resolveExecutor(options.executor);
  return {
    async acquire() {
      const rows = await exec().query<{ locked: boolean }>(SQL_TRY_ADVISORY_LOCK, [lockKey]);
      return rows[0]?.locked === true;
    },
    async release() {
      await exec().query(SQL_ADVISORY_UNLOCK, [lockKey]);
    },
  };
}
