// The pg driver's operator surface: every `JobIntrospection` member the queue grew for an
// operator, each ONE statement from `driver-pg-operator-sql.ts`. Apart from `driver-pg.ts` because
// that file is the claim/settle driver and sits near its size ceiling; this is the read-and-repair
// half a dashboard and `x jobs` call.

import { assert, finiteOption } from '@ultimat3/core';
import { REQUEUEABLE_STATES } from './driver';
import type { PgExecutor } from './driver-pg';
import { SQL_JOB_LIST, SQL_JOB_LIST_BEFORE } from './driver-pg-jobs-sql';
import {
  SQL_COUNTER_DROP,
  SQL_COUNTER_FOLD,
  SQL_COUNTER_TOTALS,
  SQL_COUNTERS,
  SQL_JOB_PROGRESS,
  SQL_JOB_PROMOTE,
  SQL_JOB_PROMOTE_MANY,
  SQL_JOB_REMOVE,
  SQL_JOB_REMOVE_MANY,
  SQL_JOB_REQUEUE_MANY,
  SQL_PAUSE,
  SQL_PAUSED,
  SQL_RESUME,
  SQL_TASK_FIRE_RECORD,
  SQL_TASK_FIRES,
  SQL_WORKER_ANNOUNCE,
  SQL_WORKER_FORGET,
  SQL_WORKERS,
} from './driver-pg-operator-sql';
import type { JobRow } from './driver-pg-rows';
import { num, toJobRecord } from './driver-pg-rows';
import { JOBS_WAKE_CHANNEL, SQL_WAKE } from './driver-pg-wake-sql';
import { JobNotRemovableError } from './errors-operator';
import type {
  BulkFilter,
  BulkResult,
  CounterBucketMs,
  JobIntrospection,
  PausedName,
} from './introspection';
import {
  COUNTER_TIERS,
  MAX_BULK_ROWS,
  MAX_TASK_FIRES,
  MAX_WORKER_IN_FLIGHT,
  PROMOTABLE_STATES,
  pageLimit,
  parseJobCursor,
} from './introspection';

export type PgOperatorMembers = Omit<
  JobIntrospection,
  'job' | 'deadLetters' | 'requeue' | 'cancel'
>;

type Count = number | string;

interface CounterRow {
  readonly job: string;
  readonly bucket_ms?: Count;
  readonly bucket_start?: Count;
  readonly done: Count;
  readonly retried: Count;
  readonly failed: Count;
  readonly dead: Count;
  readonly duration_ms: Count;
}

const counts = (row: CounterRow) => ({
  job: row.job,
  done: num(row.done),
  retried: num(row.retried),
  failed: num(row.failed),
  dead: num(row.dead),
  durationMs: num(row.duration_ms),
});

/** A `jsonb` list of strings, from a client with a type map or without one. */
function stringList(raw: unknown): readonly string[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export function pgOperator(
  exec: () => PgExecutor,
  job: JobIntrospection['job'],
): PgOperatorMembers {
  const bulk = async (sql: string, filter: BulkFilter): Promise<BulkResult> => {
    const rows = await exec().query<{ affected: Count; matching: Count }>(sql, [
      filter.state,
      filter.queue ?? null,
      filter.name ?? null,
      MAX_BULK_ROWS,
      filter.tenantId ?? null,
    ]);
    const affected = num(rows[0]?.affected);
    return { affected, remaining: Math.max(0, num(rows[0]?.matching) - affected) };
  };

  const paused = async (kind: 'queue' | 'task'): Promise<readonly PausedName[]> => {
    const rows = await exec().query<{ name: string; paused_at: Count }>(SQL_PAUSED, [kind]);
    return rows.map((row) => ({ name: row.name, pausedAt: num(row.paused_at) }));
  };

  /**
   * An operator made rows claimable — on `queue`, or on any when none is named. Announced, so
   * `x jobs retry` is a job starting now rather than at the end of an idle worker's wait.
   */
  const wake = async (queue?: string): Promise<void> => {
    await exec().query(SQL_WAKE, [JOBS_WAKE_CHANNEL, queue ?? '']);
  };

  return {
    async list(filter = {}) {
      assert(
        filter.after === undefined || filter.before === undefined,
        'list was asked for a page both after and before a cursor',
        'pass one of after: jobCursor(lastRow) or before: jobCursor(firstRow)',
      );
      const limit = pageLimit('the pg driver list', filter.limit);
      const raw = filter.before ?? filter.after;
      const cursor = raw === undefined ? undefined : parseJobCursor(raw, 'the pg driver list');
      const rows = await exec().query<JobRow>(
        filter.before === undefined ? SQL_JOB_LIST : SQL_JOB_LIST_BEFORE,
        [
          filter.queue ?? null,
          filter.name ?? null,
          filter.state ?? null,
          limit,
          filter.idPrefix ?? null,
          filter.createdFrom ?? null,
          filter.createdTo ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          filter.tenantId ?? null,
        ],
      );
      return rows.map(toJobRecord);
    },

    async remove(jobId) {
      const current = await job(jobId);
      if (current === undefined) return undefined;
      if (current.state === 'running') throw new JobNotRemovableError({ jobId });
      const gone = await exec().query<{ run_id: string }>(SQL_JOB_REMOVE, [jobId]);
      // Read as queued a moment ago and claimed since: the claim won, and the row is a worker's.
      if (gone.length === 0) throw new JobNotRemovableError({ jobId });
      return current;
    },

    // `async`, so a refused state REJECTS — the memory driver's answer, never a synchronous throw.
    async requeueMany(filter) {
      assert(
        REQUEUEABLE_STATES.has(filter.state),
        `requeueMany was asked for ${filter.state} jobs, and only a finished job can be requeued`,
        "pass state: 'dead', 'failed', 'cancelled' or 'done' to requeueMany",
      );
      const result = await bulk(SQL_JOB_REQUEUE_MANY, filter);
      if (result.affected > 0) await wake(filter.queue);
      return result;
    },

    // `async`, so a refused state REJECTS, as `requeueMany` does.
    async promoteMany(filter) {
      assert(
        PROMOTABLE_STATES.has(filter.state),
        `promoteMany was asked for ${filter.state} jobs, and only a job waiting on its run time can be promoted`,
        "pass state: 'delayed' or 'ready' to promoteMany",
      );
      const rows = await exec().query<{ affected: Count; matching: Count }>(SQL_JOB_PROMOTE_MANY, [
        filter.state,
        filter.queue ?? null,
        filter.name ?? null,
        MAX_BULK_ROWS,
        filter.tenantId ?? null,
      ]);
      return { affected: num(rows[0]?.affected), remaining: num(rows[0]?.matching) };
    },

    async removeMany(filter) {
      if (filter.state === 'running') throw new JobNotRemovableError({});
      return bulk(SQL_JOB_REMOVE_MANY, filter);
    },

    async promote(jobId) {
      const rows = await exec().query<JobRow>(SQL_JOB_PROMOTE, [jobId]);
      const row = rows[0];
      return row === undefined ? undefined : toJobRecord(row);
    },

    async pauseQueue(queue) {
      await exec().query(SQL_PAUSE, ['queue', queue]);
    },
    async resumeQueue(queue) {
      await exec().query(SQL_RESUME, ['queue', queue]);
      await wake(queue);
    },
    pausedQueues: () => paused('queue'),
    async pauseTask(task) {
      await exec().query(SQL_PAUSE, ['task', task]);
    },
    async resumeTask(task) {
      await exec().query(SQL_RESUME, ['task', task]);
    },
    pausedTasks: () => paused('task'),

    async recordTaskFire({ task, occurrenceMs }) {
      await exec().query(SQL_TASK_FIRE_RECORD, [task, occurrenceMs]);
    },
    async taskFires() {
      const rows = await exec().query<{ task_name: string; occurrence: Count; fired_at: Count }>(
        SQL_TASK_FIRES,
        [MAX_TASK_FIRES],
      );
      return rows.map((row) => ({
        task: row.task_name,
        occurrenceMs: num(row.occurrence),
        firedAt: num(row.fired_at),
      }));
    },

    async announceWorker(worker, ttlMs) {
      await exec().query(SQL_WORKER_ANNOUNCE, [
        worker.id,
        worker.host,
        JSON.stringify(worker.queues),
        worker.concurrency,
        JSON.stringify(worker.inFlight.slice(0, MAX_WORKER_IN_FLIGHT)),
        worker.startedAt,
        finiteOption('the pg worker registry', 'ttlMs', ttlMs),
      ]);
    },
    async forgetWorker(workerId) {
      await exec().query(SQL_WORKER_FORGET, [workerId]);
    },
    async workers() {
      const rows = await exec().query<{
        id: string;
        host: string;
        queues: unknown;
        concurrency: Count;
        in_flight: unknown;
        started_at: Count;
        heartbeat_at: Count;
      }>(SQL_WORKERS, []);
      return rows.map((row) => ({
        id: row.id,
        host: row.host,
        startedAt: num(row.started_at),
        queues: stringList(row.queues),
        concurrency: num(row.concurrency),
        inFlight: stringList(row.in_flight),
        heartbeatAt: num(row.heartbeat_at),
      }));
    },

    async recordProgress(jobId, by, progress) {
      await exec().query(SQL_JOB_PROGRESS, [
        jobId,
        by.workerId,
        JSON.stringify(progress),
        by.claim,
      ]);
    },

    async counters(query) {
      const rows = await exec().query<CounterRow>(SQL_COUNTERS, [query.job, query.sinceMs]);
      return rows.map((row) => ({
        ...counts(row),
        bucketStart: num(row.bucket_start),
        bucketMs: num(row.bucket_ms) as CounterBucketMs,
      }));
    },
    async counterTotals(sinceMs) {
      const rows = await exec().query<CounterRow>(SQL_COUNTER_TOTALS, [sinceMs]);
      return rows.map(counts);
    },
    async rollupCounters() {
      let moved = 0;
      for (const [index, tier] of COUNTER_TIERS.entries()) {
        const next = COUNTER_TIERS[index + 1];
        const rows = await exec().query<{ moved: Count }>(
          next === undefined ? SQL_COUNTER_DROP : SQL_COUNTER_FOLD,
          next === undefined
            ? [tier.bucketMs, tier.keepMs]
            : [tier.bucketMs, tier.keepMs, next.bucketMs],
        );
        moved += num(rows[0]?.moved);
      }
      return moved;
    },
  };
}
