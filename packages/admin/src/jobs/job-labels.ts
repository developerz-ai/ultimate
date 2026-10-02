// The catalog keys the jobs screens are labelled by, spelled out. They are the keys the admin
// would derive (`admin.<entity>.field.<name>`), named here because a key the FRAMEWORK catalog
// holds must be named by framework source (`scripts/i18n-catalog.ts`): derived, nothing could
// tell a live key from a stale one.

import type { AdminFieldOverride } from '../resource-fields';

export const RUN_LABELS = {
  title: 'admin.x_jobs.title',
  fields: {
    id: 'admin.x_jobs.field.id',
    name: 'admin.x_jobs.field.name',
    queue: 'admin.x_jobs.field.queue',
    state: 'admin.x_jobs.field.state',
    attempt: 'admin.x_jobs.field.attempt',
    maxAttempts: 'admin.x_jobs.field.maxAttempts',
    runAt: 'admin.x_jobs.field.runAt',
    createdAt: 'admin.x_jobs.field.createdAt',
    updatedAt: 'admin.x_jobs.field.updatedAt',
    tenantId: 'admin.x_jobs.field.tenantId',
    lastError: 'admin.x_jobs.field.lastError',
    lastErrorStack: 'admin.x_jobs.field.lastErrorStack',
    progress: 'admin.x_jobs.field.progress',
    input: 'admin.x_jobs.field.input',
    steps: 'admin.x_jobs.field.steps',
    traceparent: 'admin.x_jobs.field.traceparent',
    enqueuedBy: 'admin.x_jobs.field.enqueuedBy',
    claimedBy: 'admin.x_jobs.field.claimedBy',
  },
  columns: { completed: 'admin.x_jobs.column.completed', error: 'admin.x_jobs.column.error' },
} as const;

export const QUEUE_LABELS = {
  title: 'admin.x_job_queues.title',
  fields: {
    name: 'admin.x_job_queues.field.name',
    ready: 'admin.x_job_queues.field.ready',
    delayed: 'admin.x_job_queues.field.delayed',
    running: 'admin.x_job_queues.field.running',
    suspended: 'admin.x_job_queues.field.suspended',
    failed: 'admin.x_job_queues.field.failed',
    dead: 'admin.x_job_queues.field.dead',
    oldestReadyMs: 'admin.x_job_queues.field.oldestReadyMs',
    paused: 'admin.x_job_queues.field.paused',
    pausedAt: 'admin.x_job_queues.field.pausedAt',
  },
  columns: { oldest: 'admin.x_job_queues.column.oldest', jobs: 'admin.x_job_queues.column.jobs' },
} as const;

export const TASK_LABELS = {
  title: 'admin.x_job_tasks.title',
  fields: {
    name: 'admin.x_job_tasks.field.name',
    cron: 'admin.x_job_tasks.field.cron',
    tz: 'admin.x_job_tasks.field.tz',
    catchUp: 'admin.x_job_tasks.field.catchUp',
    enqueues: 'admin.x_job_tasks.field.enqueues',
    lastFireAt: 'admin.x_job_tasks.field.lastFireAt',
    nextFireAt: 'admin.x_job_tasks.field.nextFireAt',
    paused: 'admin.x_job_tasks.field.paused',
  },
} as const;

export const WORKER_LABELS = {
  title: 'admin.x_job_workers.title',
  fields: {
    id: 'admin.x_job_workers.field.id',
    host: 'admin.x_job_workers.field.host',
    queues: 'admin.x_job_workers.field.queues',
    concurrency: 'admin.x_job_workers.field.concurrency',
    inFlight: 'admin.x_job_workers.field.inFlight',
    startedAt: 'admin.x_job_workers.field.startedAt',
    heartbeatAt: 'admin.x_job_workers.field.heartbeatAt',
  },
  columns: {
    heartbeat: 'admin.x_job_workers.column.heartbeat',
    running: 'admin.x_job_workers.column.running',
  },
} as const;

/** One tab per job state, plus every row. */
export const SCOPE_LABELS = {
  all: 'admin.jobs.scope.all',
  ready: 'admin.jobs.scope.ready',
  delayed: 'admin.jobs.scope.delayed',
  running: 'admin.jobs.scope.running',
  suspended: 'admin.jobs.scope.suspended',
  done: 'admin.jobs.scope.done',
  failed: 'admin.jobs.scope.failed',
  dead: 'admin.jobs.scope.dead',
  cancelled: 'admin.jobs.scope.cancelled',
} as const;

/**
 * The step box of "retry from a step", at the key `action-input.ts` derives for it — the one input
 * an operator types on these screens. `job-actions.test.ts` pins the derivation to this name.
 */
export const RETRY_STEP_LABEL = 'admin.input.job.retry-from-step.step';

/** Each field's label key laid over the field's own overrides. */
export function labelled(
  labels: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, AdminFieldOverride>> = {},
): Readonly<Record<string, AdminFieldOverride>> {
  return Object.fromEntries(
    Object.entries(labels).map(([name, labelKey]) => [name, { ...overrides[name], labelKey }]),
  );
}
