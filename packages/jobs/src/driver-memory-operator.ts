// The memory driver's operator surface: paging, bulk, pause, promote, the worker registry,
// progress and counters, over the SAME map the claim loop reads. Apart from `driver-memory.ts`
// because that file is the six-method queue; this is everything `JobIntrospection` added, written
// to answer exactly as the pg statements in `driver-pg-operator-sql.ts` do.

import type { Clock } from '@ultimat3/core';
import { assert, finiteOption } from '@ultimat3/core';
import { nowMs } from './clock';
import type { MemoryCounters } from './counters';
import { createMemoryCounters } from './counters';
import type { JobRecord } from './driver';
import { REQUEUEABLE_STATES } from './driver';
import { signalEnqueued } from './enqueue-signal';
import { JobNotRemovableError } from './errors-operator';
import type {
  BulkFilter,
  BulkResult,
  JobFilter,
  JobIntrospection,
  PausedName,
  TaskFire,
  WorkerRecord,
} from './introspection';
import {
  MAX_BULK_ROWS,
  MAX_TASK_FIRES,
  MAX_WORKER_IN_FLIGHT,
  PROMOTABLE_STATES,
  pageLimit,
  parseJobCursor,
} from './introspection';
import type { StepStore } from './steps';

export interface MemoryQueueState {
  readonly jobs: Map<string, JobRecord>;
  readonly steps: StepStore;
  readonly clock: Clock;
  /** The LIVE row holding this record's `(name, tenant, key)`, other than itself. */
  liveHolder(record: JobRecord): JobRecord | undefined;
  /** Rewrite a row and release its claim — the driver's own `settle`. */
  settle(id: string, patch: Partial<JobRecord>): void;
}

export type MemoryOperatorMembers = Omit<
  JobIntrospection,
  'job' | 'deadLetters' | 'requeue' | 'cancel'
>;

export interface MemoryOperator {
  readonly members: MemoryOperatorMembers;
  readonly counters: MemoryCounters;
  /** The claim scan's question: is this queue held back? */
  isQueuePaused(queue: string): boolean;
}

/** Newest first by `(createdAt, id)` — the keyset `SQL_JOB_LIST` orders and seeks by. */
const newestFirst = (a: JobRecord, b: JobRecord): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const inBulk = (record: JobRecord, filter: BulkFilter): boolean =>
  record.state === filter.state &&
  (filter.queue === undefined || record.queue === filter.queue) &&
  (filter.name === undefined || record.name === filter.name) &&
  (filter.tenantId === undefined || record.tenantId === filter.tenantId);

type Keyset = Pick<JobRecord, 'createdAt' | 'id'>;

/** `a` strictly newer than `b` by `(createdAt, id)`, in the keyset's own order. */
const newerThan = (a: Keyset, b: Keyset): boolean =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

const byName = (a: PausedName, b: PausedName): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function pauseSet(clock: Clock): {
  pause(name: string): void;
  resume(name: string): void;
  has(name: string): boolean;
  list(): readonly PausedName[];
} {
  const paused = new Map<string, number>();
  return {
    // The FIRST pause is the one recorded, as `on conflict do nothing` keeps it in pg.
    pause: (name) => {
      if (!paused.has(name)) paused.set(name, nowMs(clock));
    },
    resume: (name) => {
      paused.delete(name);
    },
    has: (name) => paused.has(name),
    list: () => [...paused].map(([name, pausedAt]) => ({ name, pausedAt })).sort(byName),
  };
}

export function createMemoryOperator(state: MemoryQueueState): MemoryOperator {
  const { jobs, clock } = state;
  const counters = createMemoryCounters();
  const queues = pauseSet(clock);
  const tasks = pauseSet(clock);
  const workers = new Map<string, WorkerRecord & { readonly expiresAt: number }>();
  const fires = new Map<string, TaskFire>();

  // `eligible` is the verb's own predicate, applied BEFORE the bound as the pg statement's `where`
  // is applied before its `limit`: rows the verb would skip never spend the bound.
  const bulk = async (
    filter: BulkFilter,
    apply: (record: JobRecord) => Promise<boolean> | boolean,
    eligible: (record: JobRecord) => boolean = () => true,
  ): Promise<BulkResult> => {
    let affected = 0;
    const matching = [...jobs.values()].filter(
      (record) => inBulk(record, filter) && eligible(record),
    );
    for (const record of matching.sort(newestFirst).reverse().slice(0, MAX_BULK_ROWS)) {
      if (await apply(record)) affected += 1;
    }
    const remaining = [...jobs.values()].filter((record) => inBulk(record, filter)).length;
    return { affected, remaining };
  };

  const members: MemoryOperatorMembers = {
    // `async`, so a refused bound REJECTS here exactly as it does on the pg driver.
    async list(filter: JobFilter = {}) {
      const limit = pageLimit('the memory driver list', filter.limit);
      assert(
        filter.after === undefined || filter.before === undefined,
        'list was asked for a page both after and before a cursor',
        'pass one of after: jobCursor(lastRow) or before: jobCursor(firstRow)',
      );
      const after =
        filter.after === undefined
          ? undefined
          : parseJobCursor(filter.after, 'the memory driver list');
      const before =
        filter.before === undefined
          ? undefined
          : parseJobCursor(filter.before, 'the memory driver list');
      const { idPrefix, createdFrom, createdTo, tenantId } = filter;
      const matching = [...jobs.values()]
        .filter((record) => filter.queue === undefined || record.queue === filter.queue)
        .filter((record) => filter.name === undefined || record.name === filter.name)
        .filter((record) => filter.state === undefined || record.state === filter.state)
        .filter((record) => tenantId === undefined || record.tenantId === tenantId)
        .filter((record) => idPrefix === undefined || record.id.startsWith(idPrefix))
        .filter((record) => createdFrom === undefined || record.createdAt >= createdFrom)
        .filter((record) => createdTo === undefined || record.createdAt < createdTo)
        .filter((record) => after === undefined || newerThan(after, record))
        .filter((record) => before === undefined || newerThan(record, before))
        .sort(newestFirst);
      // Backwards: the rows NEAREST the cursor, which are the oldest of the newer ones.
      return before === undefined
        ? matching.slice(0, limit)
        : matching.slice(Math.max(0, matching.length - limit));
    },

    async remove(jobId) {
      const record = jobs.get(jobId);
      if (record === undefined) return undefined;
      if (record.state === 'running') throw new JobNotRemovableError({ jobId });
      jobs.delete(jobId);
      await state.steps.clear(record.runId);
      return record;
    },

    async requeueMany(filter) {
      assert(
        REQUEUEABLE_STATES.has(filter.state),
        `requeueMany was asked for ${filter.state} jobs, and only a finished job can be requeued`,
        "pass state: 'dead', 'failed', 'cancelled' or 'done' to requeueMany",
      );
      const result = await bulk(filter, (record) => {
        // A key a live job holds stays where it is — the single requeue's `X_JOB_DUPLICATE`,
        // answered as "not this one" so one conflict does not fail a thousand rows.
        if (state.liveHolder(record) !== undefined) return false;
        state.settle(record.id, { state: 'ready', attempt: 0, runAt: nowMs(clock) });
        return true;
      });
      // The pg driver's `SQL_WAKE`, in-process: an operator's repair starts now.
      if (result.affected > 0) signalEnqueued(filter.queue);
      return result;
    },

    async promoteMany(filter) {
      assert(
        PROMOTABLE_STATES.has(filter.state),
        `promoteMany was asked for ${filter.state} jobs, and only a job waiting on its run time can be promoted`,
        "pass state: 'delayed' or 'ready' to promoteMany",
      );
      const at = nowMs(clock);
      const result = await bulk(
        filter,
        (record) => {
          jobs.set(record.id, { ...record, state: 'ready', runAt: at, updatedAt: at });
          return true;
        },
        (record) => record.runAt > at,
      );
      if (result.affected > 0) signalEnqueued(filter.queue);
      // Rows of the filter still waiting — a due `ready` row has nothing left to promote.
      const waiting = [...jobs.values()].filter(
        (record) => inBulk(record, filter) && record.runAt > at,
      ).length;
      return { affected: result.affected, remaining: waiting };
    },

    async removeMany(filter) {
      if (filter.state === 'running') throw new JobNotRemovableError({});
      return bulk(filter, async (record) => {
        jobs.delete(record.id);
        await state.steps.clear(record.runId);
        return true;
      });
    },

    promote(jobId) {
      const record = jobs.get(jobId);
      const at = nowMs(clock);
      const waiting =
        record !== undefined &&
        (record.state === 'ready' || record.state === 'delayed') &&
        record.runAt > at;
      if (record === undefined || !waiting) return Promise.resolve(undefined);
      const next: JobRecord = { ...record, state: 'ready', runAt: at, updatedAt: at };
      jobs.set(jobId, next);
      signalEnqueued(next.queue);
      return Promise.resolve(next);
    },

    pauseQueue: (queue) => Promise.resolve(queues.pause(queue)),
    resumeQueue(queue) {
      queues.resume(queue);
      signalEnqueued(queue);
      return Promise.resolve();
    },
    pausedQueues: () => Promise.resolve(queues.list()),
    pauseTask: (task) => Promise.resolve(tasks.pause(task)),
    resumeTask: (task) => Promise.resolve(tasks.resume(task)),
    pausedTasks: () => Promise.resolve(tasks.list()),

    recordTaskFire({ task, occurrenceMs }) {
      fires.set(task, { task, occurrenceMs, firedAt: nowMs(clock) });
      return Promise.resolve();
    },
    taskFires: () =>
      Promise.resolve(
        [...fires.values()]
          // Code units, as `collate "C"` orders them in `SQL_TASK_FIRES`.
          .sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0))
          .slice(0, MAX_TASK_FIRES),
      ),

    announceWorker(worker, ttlMs) {
      const at = nowMs(clock);
      workers.set(worker.id, {
        ...worker,
        queues: [...worker.queues],
        inFlight: worker.inFlight.slice(0, MAX_WORKER_IN_FLIGHT),
        heartbeatAt: at,
        expiresAt: at + finiteOption('the memory worker registry', 'ttlMs', ttlMs),
      });
      return Promise.resolve();
    },
    forgetWorker(workerId) {
      workers.delete(workerId);
      return Promise.resolve();
    },
    workers() {
      const at = nowMs(clock);
      // Expired by reading, never by cleanup: a killed worker announces nothing and is gone.
      for (const [id, worker] of workers) if (worker.expiresAt <= at) workers.delete(id);
      return Promise.resolve(
        [...workers.values()]
          .map(({ expiresAt: _expiresAt, ...worker }) => worker)
          .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)),
      );
    },

    recordProgress(jobId, by, progress) {
      const record = jobs.get(jobId);
      // The settle's fence: progress from a claim the row no longer carries is dropped.
      if (
        record?.state === 'running' &&
        record.claimedBy === by.workerId &&
        record.claim === by.claim
      ) {
        jobs.set(jobId, { ...record, progress });
      }
      return Promise.resolve();
    },

    counters: (query) => Promise.resolve(counters.list(query)),
    counterTotals: (sinceMs) => Promise.resolve(counters.totals(sinceMs)),
    rollupCounters: () => Promise.resolve(counters.rollup(nowMs(clock))),
  };

  return { members, counters, isQueuePaused: (queue) => queues.has(queue) };
}
