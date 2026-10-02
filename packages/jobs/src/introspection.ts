// What an OPERATOR may ask of a queue, and the bounds on each answer. Every capability a
// dashboard, `x jobs` or an MCP tool has is a member of `JobIntrospection`, implemented by the pg
// and the memory driver alike, so a surface that reads only this file reads nothing a driver does
// not promise. Apart from `driver.ts` because that file is the six-method claim/settle contract;
// this one is everything said ABOUT the rows it moves.

import { finiteCount } from '@ultimat3/core';
import type { ClaimIdentity, JobRecord, JobState } from './driver';
import { JobPageInvalidError } from './errors-operator';

/** Rows one `list()` call may answer. A page, never a table: a dashboard walks with `after`. */
export const MAX_JOB_PAGE = 200;
export const DEFAULT_JOB_PAGE = 100;
/** Rows one `requeueMany` / `removeMany` call may touch. It answers how many remain. */
export const MAX_BULK_ROWS = 1_000;
/** Gap between two progress writes of ONE run. The last call before a settle is always written. */
export const PROGRESS_INTERVAL_MS = 1_000;
export const MAX_PROGRESS_NOTE_LENGTH = 200;
/** How much of a thrown value's stack a row keeps. A stack is a diagnosis, not an archive. */
export const MAX_ERROR_STACK_LENGTH = 8_000;
/** In-flight job ids one registry row lists. A worker holding more reports the first of them. */
export const MAX_WORKER_IN_FLIGHT = 100;
/** Rows `taskFires()` answers. A task renamed away leaves its row behind; a screen is not a table. */
export const MAX_TASK_FIRES = 1_000;

/**
 * The counter tiers: a bucket width, and how long buckets of that width are kept. One-minute
 * buckets for a day, five-minute for a week, hourly for thirty days — 1,440 + 2,016 + 720 rows per
 * job name whatever the throughput, which is the whole point: history that costs the same at ten
 * jobs an hour and at ten million.
 */
export const COUNTER_TIERS = Object.freeze([
  Object.freeze({ bucketMs: 60_000, keepMs: 86_400_000 }),
  Object.freeze({ bucketMs: 300_000, keepMs: 604_800_000 }),
  Object.freeze({ bucketMs: 3_600_000, keepMs: 2_592_000_000 }),
] as const);

export type CounterBucketMs = (typeof COUNTER_TIERS)[number]['bucketMs'];

/** The tier every settle writes to. Coarser ones are filled by `rollupCounters` only. */
export const COUNTER_BUCKET_MS = COUNTER_TIERS[0].bucketMs;

export interface JobFilter {
  readonly queue?: string;
  readonly name?: string;
  readonly state?: JobState;
  /** Rows whose id STARTS with this — an operator pastes the first characters of one. */
  readonly idPrefix?: string;
  /** Epoch ms, inclusive. Rows created at or after it. */
  readonly createdFrom?: number;
  /** Epoch ms, exclusive. Rows created before it. */
  readonly createdTo?: number;
  /** 1 to `MAX_JOB_PAGE`. Default `DEFAULT_JOB_PAGE`. */
  readonly limit?: number;
  /**
   * `jobCursor(lastRowOfThePreviousPage)`. Keyset, never an offset: the order is newest first by
   * `(createdAt, id)`, so a row inserted while a walk is in flight sorts BEFORE every cursor and
   * each row already there is visited exactly once.
   */
  readonly after?: string;
  /**
   * `jobCursor(firstRowOfThisPage)` — the page BEFORE it: the `limit` rows nearest the cursor on
   * its newer side, answered newest first like every page. What a dashboard's "previous" reads.
   * Never with `after`.
   */
  readonly before?: string;
  /** Rows queued for this tenant only (`JobRecord.tenantId`). An org-scoped operator's list. */
  readonly tenantId?: string;
}

const CURSOR = /^(\d{1,16}):([0-9A-Za-z-]{1,64})$/;

/** The cursor a page's LAST row yields. A page shorter than its limit is the last page. */
export function jobCursor(record: Pick<JobRecord, 'createdAt' | 'id'>): string {
  return `${record.createdAt}:${record.id}`;
}

export function parseJobCursor(
  after: string,
  subject = 'the job list',
): { readonly createdAt: number; readonly id: string } {
  const match = CURSOR.exec(after);
  if (match === null) throw new JobPageInvalidError({ subject, maxPage: MAX_JOB_PAGE });
  return { createdAt: Number(match[1]), id: match[2] ?? '' };
}

/** `limit`, defaulted and refused past the bound — a caller never widens a page by asking. */
export function pageLimit(subject: string, limit: number | undefined): number {
  const asked = finiteCount(subject, 'limit', limit ?? DEFAULT_JOB_PAGE);
  if (asked > MAX_JOB_PAGE) {
    throw new JobPageInvalidError({ subject, maxPage: MAX_JOB_PAGE, limit: asked });
  }
  return asked;
}

/** Which rows a bulk call addresses. `state` is REQUIRED: "every job" is never one call. */
export interface BulkFilter {
  readonly state: JobState;
  readonly queue?: string;
  readonly name?: string;
  /** One tenant's rows only — what an org-scoped operator's "all matching" may touch. */
  readonly tenantId?: string;
}

/** The states `promoteMany` accepts: the two a row waiting on its `runAt` can be in. */
export const PROMOTABLE_STATES: ReadonlySet<JobState> = new Set<JobState>(['ready', 'delayed']);

export interface BulkResult {
  /** Rows this call changed — at most `MAX_BULK_ROWS`. */
  readonly affected: number;
  /** Rows still matching the filter afterwards. Call again until it is zero. */
  readonly remaining: number;
}

export interface PausedName {
  readonly name: string;
  /** Epoch ms. */
  readonly pausedAt: number;
}

/** What a worker says about itself. The registry adds `heartbeatAt`. */
export interface WorkerAnnouncement {
  readonly id: string;
  readonly host: string;
  /** Epoch ms this worker started. */
  readonly startedAt: number;
  readonly queues: readonly string[];
  /** Slots across every queue this worker serves. */
  readonly concurrency: number;
  /** Job ids it holds right now — the first `MAX_WORKER_IN_FLIGHT` of them. */
  readonly inFlight: readonly string[];
}

export interface WorkerRecord extends WorkerAnnouncement {
  /** Epoch ms of the announcement that wrote this row. */
  readonly heartbeatAt: number;
}

/**
 * The last occurrence of a task that DISPATCHED — queued its jobs. Arming a task first seen, or
 * skipping occurrences a `catchUp` policy drops, moves the scheduler's watermark and is not one.
 */
export interface TaskFire {
  readonly task: string;
  /** Epoch ms the occurrence was scheduled for. */
  readonly occurrenceMs: number;
  /** Epoch ms it was dispatched, on the store's clock. */
  readonly firedAt: number;
}

export interface JobProgress {
  readonly done: number;
  readonly total: number;
  readonly note?: string;
  /** Epoch ms the body reported it. */
  readonly at: number;
}

/** What one settle adds to its job's current bucket. Exactly one of the four counts is 1. */
export type CounterOutcome = 'done' | 'retried' | 'failed' | 'dead';

export interface JobCounter {
  readonly job: string;
  /** Epoch ms the bucket opens. */
  readonly bucketStart: number;
  readonly bucketMs: CounterBucketMs;
  readonly done: number;
  /** Attempts that failed and were handed back for another. */
  readonly retried: number;
  /** Runs that ended `failed`: refused by a busy key, or exhausted on a `deadLetter: false` job. */
  readonly failed: number;
  readonly dead: number;
  /** Sum of the attempts' durations, so `durationMs / (done + retried + failed + dead)` is a mean. */
  readonly durationMs: number;
}

export type CounterTotals = Omit<JobCounter, 'bucketStart' | 'bucketMs'>;

/** A driver's operator surface. Every member is implemented by every driver that ships one. */
export interface JobIntrospection {
  job(jobId: string): Promise<JobRecord | undefined>;
  /** One page, newest first. See `JobFilter.after`. */
  list(filter?: JobFilter): Promise<readonly JobRecord[]>;
  deadLetters(limit?: number): Promise<readonly JobRecord[]>;
  /**
   * Re-queue a finished job (`REQUEUEABLE_STATES`); a live one is `X_JOB_NOT_REQUEUEABLE`, and a
   * key a live job holds is `X_JOB_DUPLICATE`. `fromStep` drops that step and every step that
   * started after it.
   */
  requeue(jobId: string, options?: { readonly fromStep?: string }): Promise<JobRecord>;
  /**
   * Stop a job from outside. Terminal for a queued row immediately; a RUNNING one stops at its
   * next heartbeat, which no longer matches its own row and cancels the attempt. Answers
   * `undefined` for a job id it does not hold or one that already finished. Optional, as it
   * shipped: a driver may have no way to address a single running row.
   */
  cancel?(jobId: string, reason?: string): Promise<JobRecord | undefined>;
  /**
   * Delete one job and its step records. `undefined` for an id nobody queued. A RUNNING job is
   * refused (`X_JOB_NOT_REMOVABLE`): a worker holds it, and deleting the row under a body does
   * not stop the body — cancel it first.
   */
  remove(jobId: string): Promise<JobRecord | undefined>;
  /**
   * Re-queue up to `MAX_BULK_ROWS` finished jobs. `filter.state` must be a requeueable state. A
   * row whose key a live job holds is left where it is and counted in `remaining`.
   */
  requeueMany(filter: BulkFilter): Promise<BulkResult>;
  /** Delete up to `MAX_BULK_ROWS` jobs. `filter.state` may be any state but `running`. */
  removeMany(filter: BulkFilter): Promise<BulkResult>;
  /**
   * Make a job waiting on its `runAt` — delayed at enqueue, or backing off before a retry — due
   * now. `undefined` when the job is not waiting on a clock (missing, running, finished, or
   * suspended in a `step.sleep`, whose wake time is the step's and not the row's).
   */
  promote(jobId: string): Promise<JobRecord | undefined>;
  /**
   * `promote`, over up to `MAX_BULK_ROWS` rows: every one in `filter` still waiting on its
   * `runAt` is due now. `filter.state` must be `ready` (a retry backing off) or `delayed`.
   */
  promoteMany(filter: BulkFilter): Promise<BulkResult>;
  /** A paused queue is never claimed, by any worker; enqueues still land. Idempotent. */
  pauseQueue(queue: string): Promise<void>;
  resumeQueue(queue: string): Promise<void>;
  pausedQueues(): Promise<readonly PausedName[]>;
  /**
   * A paused task is not dispatched. On resume its own `catchUp` policy decides what the pause
   * missed — exactly as if the scheduler had been down.
   */
  pauseTask(task: string): Promise<void>;
  resumeTask(task: string): Promise<void>;
  pausedTasks(): Promise<readonly PausedName[]>;
  /**
   * The scheduler's record that an occurrence dispatched; the store stamps `firedAt`. The pg
   * driver's own fire writes it in the firing statement (`SQL_SCHEDULER_FIRE`), so only a fire
   * that goes through `driver.enqueue` calls this.
   */
  recordTaskFire(fire: Pick<TaskFire, 'task' | 'occurrenceMs'>): Promise<void>;
  /** Every task that has dispatched, by task name — the first `MAX_TASK_FIRES` of them. */
  taskFires(): Promise<readonly TaskFire[]>;
  /** A worker's heartbeat. The row expires `ttlMs` after the last one — never by cleanup. */
  announceWorker(worker: WorkerAnnouncement, ttlMs: number): Promise<void>;
  /** A clean stop hands the row back at once rather than leaving it to expire. */
  forgetWorker(workerId: string): Promise<void>;
  /** Every worker whose row has not expired, oldest start first. */
  workers(): Promise<readonly WorkerRecord[]>;
  /** Fenced on the CLAIM, as a settle is: progress from one the row no longer carries is dropped. */
  recordProgress(jobId: string, by: ClaimIdentity, progress: JobProgress): Promise<void>;
  /** One job's buckets from `sinceMs` on, oldest first, at whatever tier each still lives in. */
  counters(query: {
    readonly job: string;
    readonly sinceMs: number;
  }): Promise<readonly JobCounter[]>;
  /** One row per job name: every bucket from `sinceMs` on, summed. Ordered by name. */
  counterTotals(sinceMs: number): Promise<readonly CounterTotals[]>;
  /**
   * Fold buckets past their tier's `keepMs` into the next tier and drop the ones past the last.
   * The scheduler leader calls it; it is idempotent, and safe if two nodes both do. Answers how
   * many buckets it moved or dropped.
   */
  rollupCounters(): Promise<number>;
}
