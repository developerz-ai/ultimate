// What Postgres hands back, and what the queue speaks in: the row shapes the driver's statements
// return and the one mapping from each onto its wire record. Apart from `driver-pg.ts` because
// decoding a row is not control flow — every number arrives as `number | string` (a bigint is a
// string in every client) and every absent column as `null`, and that translation is its own job.

import { BACKFILL_STATUSES, type BackfillRun, isBackfillStatus } from './backfill-ledger';
import { isJobState, JOB_STATES, type JobRecord, type JobState } from './driver';
import { JobRowStatusUnknownError } from './errors';
import { isStepStatus, STEP_STATUSES, type StepRecord, type StepStatus } from './steps';

export interface StepRow {
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

export interface BackfillRow {
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

export interface JobRow {
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
  readonly traceparent?: string | null;
  readonly enqueued_by?: string | null;
}

/**
 * The one narrowing for all three status columns. `as` is not a check, and these rows cross a
 * process boundary — a queue row was written by whatever build was deployed when the job was
 * enqueued, which on a rolling deploy is not this one. `isBackfillStatus`'s own doc already stated
 * the rule ("Never a cast — the list decides") and this file was the caller ignoring it.
 */
const statusIn = <T extends string>(
  known: readonly T[],
  is: (value: string) => value is T,
  input: { table: string; column: string; value: string },
): T => {
  if (is(input.value)) return input.value;
  throw new JobRowStatusUnknownError({ ...input, known });
};

export const num = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const optionalNum = (value: number | string | null | undefined): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

export function toJobRecord(row: JobRow): JobRecord {
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
    state: statusIn<JobState>(JOB_STATES, isJobState, {
      table: 'ultimate_jobs',
      column: 'state',
      value: row.state,
    }),
    runAt: num(row.run_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(visibleAt === undefined ? {} : { visibleAt }),
    ...(row.traceparent === null || row.traceparent === undefined
      ? {}
      : { traceparent: row.traceparent }),
    ...(row.enqueued_by === null || row.enqueued_by === undefined
      ? {}
      : { enqueuedBy: row.enqueued_by }),
  };
}

export function toStepRecord(row: StepRow): StepRecord {
  const completedAt = optionalNum(row.completed_at);
  const wakeAt = optionalNum(row.wake_at);
  return {
    runId: row.run_id,
    name: row.name,
    status: statusIn<StepStatus>(STEP_STATUSES, isStepStatus, {
      table: 'ultimate_job_steps',
      column: 'status',
      value: row.status,
    }),
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

export function toBackfillRun(row: BackfillRow): BackfillRun {
  const completedAt = optionalNum(row.completed_at);
  return {
    runId: row.run_id,
    name: row.name,
    checksum: row.checksum,
    status: statusIn(BACKFILL_STATUSES, isBackfillStatus, {
      table: 'ultimate_backfills',
      column: 'status',
      value: row.status,
    }),
    appVersion: row.app_version,
    // `rows_processed` is a bigint, which every Postgres client hands back as a string.
    rows: num(row.rows_processed),
    cursor: row.last_cursor,
    startedAt: num(row.started_at),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}
