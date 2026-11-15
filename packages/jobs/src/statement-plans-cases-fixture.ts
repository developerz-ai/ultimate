// Every framework jobs statement, with the parameters the driver binds on its real path — what
// `statement-plans.live.test.ts` plans against the seeded queue. Keyed by the export's name, so the
// test can hold this table equal to the statements the package's source DECLARES: a new
// `export const SQL_*` with no row here fails before any plan is read.

import { SQL_CLAIM, SQL_CLAIM_IDLE } from './driver-pg-claim-sql';
import { SQL_QUEUE_DEMAND } from './driver-pg-demand-sql';
import { SQL_ENQUEUE_MANY, SQL_ENQUEUE_MANY_RESOLVE } from './driver-pg-enqueue-many';
import { SQL_BACKLOG, SQL_ENQUEUE, SQL_ENQUEUE_REPLACE } from './driver-pg-enqueue-sql';
import { SQL_EVENT_COMMIT_WAKE, SQL_EVENT_PUBLISH_WAKE } from './driver-pg-event-wake-sql';
import {
  SQL_JOB_DEAD_LETTERS,
  SQL_JOB_GET,
  SQL_JOB_LIST,
  SQL_JOB_LIST_BEFORE,
  SQL_JOB_LIVE_HOLDER,
  SQL_JOB_REQUEUE,
} from './driver-pg-jobs-sql';
import {
  SQL_COUNTER_DROP,
  SQL_COUNTER_FOLD,
  SQL_COUNTER_TOTALS,
  SQL_COUNTERS,
  SQL_COUNTERS_MANY,
  SQL_JOB_PROGRESS,
  SQL_JOB_PROMOTE,
  SQL_JOB_PROMOTE_MANY,
  SQL_JOB_REMOVE,
  SQL_JOB_REMOVE_MANY,
  SQL_JOB_REQUEUE_MANY,
  SQL_PAUSE,
  SQL_PAUSED,
  SQL_RESUME,
  SQL_SCHEDULER_FIRE,
  SQL_STEP_RESOLVE,
  SQL_TASK_FIRE_RECORD,
  SQL_TASK_FIRES,
  SQL_WORKER_ANNOUNCE,
  SQL_WORKER_FORGET,
  SQL_WORKER_RENEW,
  SQL_WORKERS,
} from './driver-pg-operator-sql';
import {
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_CLAIM_IDLE,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_MARK_PUBLISHED_MANY,
  SQL_OUTBOX_PENDING_COUNT,
  SQL_OUTBOX_PUBLISHED_JOB,
  SQL_OUTBOX_RELEASE,
  SQL_OUTBOX_STAGE,
  SQL_OUTBOX_STAGE_MANY,
} from './driver-pg-outbox-sql';
import {
  SQL_ACK,
  SQL_COUNTER_FLUSH,
  SQL_NACK,
  SQL_SETTLE_CLEAR,
  SQL_SETTLE_TAKE_LOST,
} from './driver-pg-settle-sql';
import {
  SQL_ADVISORY_UNLOCK,
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_PROGRESS,
  SQL_BACKFILL_START,
  SQL_CANCEL,
  SQL_EVENT_FIND,
  SQL_EVENT_LIST,
  SQL_EVENT_MARK,
  SQL_EVENT_NOW,
  SQL_EVENT_PUBLISH,
  SQL_EVENT_PURGE_COUNTED,
  SQL_FIND_LIVE_BY_KEY,
  SQL_HEARTBEAT,
  SQL_LEADER_ACQUIRE,
  SQL_LEADER_RELEASE,
  SQL_LEASE_ACQUIRE,
  SQL_LEASE_HOLDERS,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_SCHEDULER_STATE_GET,
  SQL_SCHEDULER_STATE_MARK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_LIST,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
import { SQL_WAKE } from './driver-pg-wake-sql';
import {
  SQL_JOBS_RETENTION_BATCH,
  SQL_JOBS_RETENTION_ORPHANS,
  SQL_JOBS_RETENTION_STEPS,
} from './jobs-retention';
import { SQL_OUTBOX_RETENTION_BATCH } from './outbox-retention';
import { SQL_SCALER_DEMAND } from './scaler-depth-fixture';
import { SQL_SCHEDULER_STATE_ALL } from './scheduler-pg';
import { SEEDED } from './statement-plans-seed-fixture';

/** One call of a statement: what it is asked, and the bound values. */
export interface PlanCase {
  readonly label: string;
  readonly params: readonly unknown[];
}

export interface PlannedStatement {
  readonly sql: string;
  readonly cases: readonly PlanCase[];
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const one = (params: readonly unknown[]): readonly PlanCase[] => [{ label: 'the call', params }];

const enqueueParams = (key: string, runAtMs: number): readonly unknown[] => [
  crypto.randomUUID(),
  'mail.send',
  'mail',
  '{"to":"a"}',
  key,
  crypto.randomUUID(),
  3,
  runAtMs,
  'org-3',
  null,
  null,
  null,
];

const manyRequests = (count: number, now: number): string =>
  JSON.stringify(
    Array.from({ length: count }, (_, ord) => ({
      ord,
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      name: 'mail.send',
      queue: ord % 2 === 0 ? 'mail' : 'default',
      input: { ord },
      idempotencyKey: `many:${ord}`,
      maxAttempts: 3,
      runAt: now,
      tenantId: 'org-3',
      stagedAt: now,
      job: 'mail.send',
    })),
  );

/** `LIST_MATCH`'s order: queue, name, state, limit, id prefix, from, to, cursor ms, cursor id, tenant. */
const listParams = (over: Partial<Record<number, unknown>> = {}): readonly unknown[] =>
  [null, null, null, 50, null, null, null, null, null, null].map((value, index) =>
    index in over ? over[index] : value,
  );

/** $1 state, $2 queue, $3 name, $4 limit, $5 tenant. */
const bulk = (state: string): readonly unknown[] => [state, null, null, 100, null];

/**
 * The table at the DATABASE's instant, `NOW` (epoch ms): the test process runs on a frozen clock,
 * and a cutoff bound from it selects nothing a seed written at the server's `now()` holds — an
 * empty batch plans nothing worth reading. Built once per run, so two cases of a statement agree.
 */
export const planned = (NOW: number): Readonly<Record<string, PlannedStatement>> => ({
  SQL_CLAIM: {
    sql: SQL_CLAIM,
    cases: [
      { label: 'two busy queues', params: [['default', 'mail'], 8, 'worker-z', 30_000, [], []] },
      { label: 'one queue', params: [['reports'], 8, 'worker-z', 30_000, [], []] },
    ],
  },
  SQL_CLAIM_IDLE: {
    sql: SQL_CLAIM_IDLE,
    cases: [
      {
        label: 'a queue with only future rows',
        params: [['digest'], 8, 'worker-z', 30_000, [], []],
      },
    ],
  },
  SQL_ACK: { sql: SQL_ACK, cases: one([SEEDED.running, SEEDED.worker, 1, false]) },
  SQL_NACK: {
    sql: SQL_NACK,
    cases: one([SEEDED.running, 'ready', true, 1_000, 'boom', SEEDED.worker, 'at x', 1, false]),
  },
  SQL_HEARTBEAT: { sql: SQL_HEARTBEAT, cases: one([SEEDED.running, 30_000, SEEDED.worker, 1]) },
  SQL_CANCEL: { sql: SQL_CANCEL, cases: one([SEEDED.delayed, 'stopped']) },
  SQL_FIND_LIVE_BY_KEY: {
    sql: SQL_FIND_LIVE_BY_KEY,
    cases: one(['mail.send', 'named:running', 'org-3']),
  },
  SQL_ENQUEUE: {
    sql: SQL_ENQUEUE,
    cases: [
      { label: 'due now', params: enqueueParams('fresh:1', NOW) },
      { label: 'a duplicate', params: enqueueParams('named:running', NOW) },
    ],
  },
  SQL_ENQUEUE_REPLACE: {
    sql: SQL_ENQUEUE_REPLACE,
    cases: one(enqueueParams('fresh:2', NOW + MIN)),
  },
  SQL_BACKLOG: { sql: SQL_BACKLOG, cases: one(['mail', 1_000]) },
  SQL_ENQUEUE_MANY: { sql: SQL_ENQUEUE_MANY, cases: one([manyRequests(200, NOW)]) },
  SQL_ENQUEUE_MANY_RESOLVE: { sql: SQL_ENQUEUE_MANY_RESOLVE, cases: one([manyRequests(200, NOW)]) },
  SQL_STATS: { sql: SQL_STATS, cases: one([]) },
  SQL_QUEUE_DEMAND: { sql: SQL_QUEUE_DEMAND, cases: one([]) },
  SQL_SCALER_DEMAND: { sql: SQL_SCALER_DEMAND, cases: one([['default', 'mail']]) },
  SQL_JOB_GET: { sql: SQL_JOB_GET, cases: one([SEEDED.running]) },
  SQL_JOB_LIST: {
    sql: SQL_JOB_LIST,
    cases: [
      { label: 'the first page', params: listParams() },
      { label: 'the next page', params: listParams({ 7: NOW - DAY, 8: SEEDED.dead }) },
      { label: 'one queue', params: listParams({ 0: 'mail' }) },
      { label: 'one state', params: listParams({ 2: 'dead' }) },
      { label: 'one tenant', params: listParams({ 9: 'org-3' }) },
    ],
  },
  SQL_JOB_LIST_BEFORE: {
    sql: SQL_JOB_LIST_BEFORE,
    cases: one(listParams({ 7: NOW - DAY, 8: SEEDED.dead })),
  },
  SQL_JOB_DEAD_LETTERS: { sql: SQL_JOB_DEAD_LETTERS, cases: one([50]) },
  SQL_JOB_REQUEUE: { sql: SQL_JOB_REQUEUE, cases: one([SEEDED.dead, 'charge']) },
  SQL_JOB_LIVE_HOLDER: {
    sql: SQL_JOB_LIVE_HOLDER,
    cases: one(['mail.send', 'org-3', 'named:dead', SEEDED.dead]),
  },
  SQL_JOB_REQUEUE_MANY: { sql: SQL_JOB_REQUEUE_MANY, cases: one(bulk('dead')) },
  SQL_JOB_REMOVE_MANY: { sql: SQL_JOB_REMOVE_MANY, cases: one(bulk('dead')) },
  SQL_JOB_PROMOTE_MANY: { sql: SQL_JOB_PROMOTE_MANY, cases: one(bulk('delayed')) },
  SQL_JOB_REMOVE: { sql: SQL_JOB_REMOVE, cases: one([SEEDED.dead]) },
  SQL_JOB_PROMOTE: { sql: SQL_JOB_PROMOTE, cases: one([SEEDED.delayed]) },
  SQL_JOB_PROGRESS: {
    sql: SQL_JOB_PROGRESS,
    cases: one([SEEDED.running, SEEDED.worker, '{"done":1}', 1]),
  },
  SQL_PAUSE: { sql: SQL_PAUSE, cases: one(['queue', 'reports']) },
  SQL_RESUME: { sql: SQL_RESUME, cases: one(['queue', 'reports']) },
  SQL_PAUSED: { sql: SQL_PAUSED, cases: one(['queue']) },
  SQL_WORKER_ANNOUNCE: {
    sql: SQL_WORKER_ANNOUNCE,
    cases: one([SEEDED.worker, 'host-a', '["mail"]', 8, '[]', NOW, MIN, false, 'b1']),
  },
  SQL_WORKER_RENEW: { sql: SQL_WORKER_RENEW, cases: one([SEEDED.worker, MIN]) },
  SQL_WORKER_FORGET: { sql: SQL_WORKER_FORGET, cases: one([SEEDED.worker]) },
  SQL_WORKERS: { sql: SQL_WORKERS, cases: one([]) },
  SQL_COUNTERS: { sql: SQL_COUNTERS, cases: one(['mail.send', NOW - DAY]) },
  SQL_COUNTERS_MANY: {
    sql: SQL_COUNTERS_MANY,
    cases: one([['mail.send', 'report.build'], NOW - DAY]),
  },
  SQL_COUNTER_TOTALS: { sql: SQL_COUNTER_TOTALS, cases: one([NOW - DAY]) },
  SQL_COUNTER_FOLD: { sql: SQL_COUNTER_FOLD, cases: one([MIN, 60 * MIN, 60 * MIN]) },
  SQL_COUNTER_DROP: { sql: SQL_COUNTER_DROP, cases: one([DAY, 30 * DAY]) },
  SQL_COUNTER_FLUSH: {
    sql: SQL_COUNTER_FLUSH,
    cases: one([
      MIN,
      JSON.stringify([
        { job: 'mail.send', startMs: NOW, done: 1, retried: 0, failed: 0, dead: 0, durationMs: 5 },
      ]),
    ]),
  },
  SQL_TASK_FIRE_RECORD: { sql: SQL_TASK_FIRE_RECORD, cases: one(['task-7', NOW]) },
  SQL_TASK_FIRES: { sql: SQL_TASK_FIRES, cases: one([100]) },
  SQL_SCHEDULER_FIRE: {
    sql: SQL_SCHEDULER_FIRE,
    cases: one([
      'task-7',
      NOW,
      JSON.stringify([
        {
          id: crypto.randomUUID(),
          name: 'report.build',
          queue: 'reports',
          input: {},
          idempotency_key: `task-7:${NOW}:k`,
          run_id: crypto.randomUUID(),
          max_attempts: 3,
        },
      ]),
      null,
    ]),
  },
  SQL_SCHEDULER_STATE_GET: { sql: SQL_SCHEDULER_STATE_GET, cases: one(['task-7']) },
  SQL_SCHEDULER_STATE_ALL: {
    sql: SQL_SCHEDULER_STATE_ALL,
    cases: one([['task-1', 'task-7', 'task-43']]),
  },
  SQL_SCHEDULER_STATE_MARK: { sql: SQL_SCHEDULER_STATE_MARK, cases: one(['task-7', NOW]) },
  SQL_STEP_RESOLVE: {
    sql: SQL_STEP_RESOLVE,
    cases: one([SEEDED.dead, 'charge', 'completed', '{"ok":true}']),
  },
  SQL_WAKE: { sql: SQL_WAKE, cases: one(['x_jobs_wake', 'mail']) },
  SQL_EVENT_PUBLISH_WAKE: {
    sql: SQL_EVENT_PUBLISH_WAKE,
    cases: one([crypto.randomUUID(), SEEDED.event, '{}', 'k1', MIN]),
  },
  SQL_EVENT_COMMIT_WAKE: { sql: SQL_EVENT_COMMIT_WAKE, cases: one([SEEDED.event, 'k1']) },
  SQL_EVENT_PUBLISH: {
    sql: SQL_EVENT_PUBLISH,
    cases: one([crypto.randomUUID(), SEEDED.event, '{}', 'k1', MIN]),
  },
  SQL_EVENT_NOW: { sql: SQL_EVENT_NOW, cases: one([]) },
  SQL_EVENT_MARK: { sql: SQL_EVENT_MARK, cases: one([]) },
  SQL_EVENT_FIND: {
    sql: SQL_EVENT_FIND,
    cases: one(['event.3', 'k3', NOW - DAY, null, null, NOW - DAY, null, null]),
  },
  SQL_EVENT_LIST: { sql: SQL_EVENT_LIST, cases: one(['event.3', 100]) },
  SQL_EVENT_PURGE_COUNTED: { sql: SQL_EVENT_PURGE_COUNTED, cases: one([]) },
  SQL_OUTBOX_STAGE: {
    sql: SQL_OUTBOX_STAGE,
    cases: one([
      crypto.randomUUID(),
      'mail.send',
      'mail',
      '{}',
      'stage:1',
      3,
      NOW,
      NOW,
      'org-3',
      null,
      null,
      crypto.randomUUID(),
      null,
      null,
    ]),
  },
  SQL_OUTBOX_STAGE_MANY: { sql: SQL_OUTBOX_STAGE_MANY, cases: one([manyRequests(200, NOW)]) },
  SQL_OUTBOX_CLAIM: { sql: SQL_OUTBOX_CLAIM, cases: one([100, 30_000, 'relay-z']) },
  SQL_OUTBOX_CLAIM_IDLE: { sql: SQL_OUTBOX_CLAIM_IDLE, cases: one([100, 30_000, 'relay-z']) },
  SQL_OUTBOX_RELEASE: {
    sql: SQL_OUTBOX_RELEASE,
    cases: one([[SEEDED.outboxClaimed], SEEDED.relay]),
  },
  SQL_OUTBOX_MARK_PUBLISHED: {
    sql: SQL_OUTBOX_MARK_PUBLISHED,
    cases: one([SEEDED.outboxClaimed, NOW, SEEDED.relay]),
  },
  SQL_OUTBOX_MARK_PUBLISHED_MANY: {
    sql: SQL_OUTBOX_MARK_PUBLISHED_MANY,
    cases: one([[SEEDED.outboxClaimed], NOW, SEEDED.relay]),
  },
  SQL_OUTBOX_PUBLISHED_JOB: { sql: SQL_OUTBOX_PUBLISHED_JOB, cases: one([SEEDED.running]) },
  SQL_OUTBOX_PENDING_COUNT: { sql: SQL_OUTBOX_PENDING_COUNT, cases: one([]) },
  SQL_OUTBOX_RETENTION_BATCH: {
    sql: SQL_OUTBOX_RETENTION_BATCH,
    cases: one([NOW, 3_600_000, 500]),
  },
  SQL_SETTLE_CLEAR: { sql: SQL_SETTLE_CLEAR, cases: one([SEEDED.done, 1]) },
  SQL_SETTLE_TAKE_LOST: {
    sql: SQL_SETTLE_TAKE_LOST,
    cases: one([JSON.stringify([{ name: 'mail.send', graceMs: MIN }]), 100]),
  },
  SQL_JOBS_RETENTION_BATCH: {
    sql: SQL_JOBS_RETENTION_BATCH,
    cases: one([7 * DAY, 14 * DAY, 500, null, null]),
  },
  SQL_JOBS_RETENTION_STEPS: {
    sql: SQL_JOBS_RETENTION_STEPS,
    cases: one([JSON.stringify([SEEDED.doneRun, SEEDED.deadRun])]),
  },
  SQL_JOBS_RETENTION_ORPHANS: { sql: SQL_JOBS_RETENTION_ORPHANS, cases: one([7 * DAY, 1_000]) },
  SQL_TRY_ADVISORY_LOCK: { sql: SQL_TRY_ADVISORY_LOCK, cases: one([42]) },
  SQL_ADVISORY_UNLOCK: { sql: SQL_ADVISORY_UNLOCK, cases: one([42]) },
  SQL_LEADER_ACQUIRE: { sql: SQL_LEADER_ACQUIRE, cases: one(['scheduler', 'node-a', MIN]) },
  SQL_LEADER_RELEASE: { sql: SQL_LEADER_RELEASE, cases: one(['scheduler', 'node-a']) },
  SQL_LEASE_ACQUIRE: { sql: SQL_LEASE_ACQUIRE, cases: one(['mail.send', 'h1', 4, 30_000]) },
  SQL_LEASE_RENEW: { sql: SQL_LEASE_RENEW, cases: one(['mail.send', 0, 'h1', 30_000]) },
  SQL_LEASE_RELEASE: { sql: SQL_LEASE_RELEASE, cases: one(['mail.send', 0, 'h1']) },
  SQL_LEASE_HOLDERS: { sql: SQL_LEASE_HOLDERS, cases: one(['mail.send']) },
  SQL_STEP_GET: { sql: SQL_STEP_GET, cases: one([SEEDED.runningRun, 'fetch']) },
  SQL_STEP_LIST: { sql: SQL_STEP_LIST, cases: one([SEEDED.runningRun]) },
  SQL_STEP_PUT: {
    sql: SQL_STEP_PUT,
    cases: one([
      SEEDED.runningRun,
      'send',
      'completed',
      '{}',
      NOW,
      NOW,
      null,
      null,
      null,
      1,
      null,
      SEEDED.running,
      SEEDED.worker,
      1,
    ]),
  },
  SQL_BACKFILL_START: {
    sql: SQL_BACKFILL_START,
    cases: one([crypto.randomUUID(), 'backfill-x', 'c', 'v1']),
  },
  SQL_BACKFILL_PROGRESS: { sql: SQL_BACKFILL_PROGRESS, cases: one([crypto.randomUUID(), 10, 'c']) },
  SQL_BACKFILL_FINISH: {
    sql: SQL_BACKFILL_FINISH,
    cases: one([crypto.randomUUID(), 'completed', 10]),
  },
  SQL_BACKFILL_LIST: { sql: SQL_BACKFILL_LIST, cases: one([null, null, null, 50]) },
});
