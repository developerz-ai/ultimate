// The four things an operator browses — job rows, queues, tasks, workers — declared as the entity
// SURFACE the admin derives every screen from (`registry.ts`'s `AdminEntity`), so their lists,
// filters, detail pages, batch bar and MCP tools are the ones an app's own tables get. Hand-built
// rather than `entity()`: none is an app table, and `entity()` would put them in the app's schema.

import { JOB_STATES } from '@ultimat3/jobs';
import type { AdminColumn, AdminColumnMeta, AdminEntity } from '../registry';

/** The resource names. `x_` is the framework's table prefix: no app entity is named so. */
export const JOB_ENTITY = {
  jobs: 'x_jobs',
  queues: 'x_job_queues',
  tasks: 'x_job_tasks',
  workers: 'x_job_workers',
} as const;

type Shape = Partial<Omit<AdminColumnMeta, 'kind'>>;

const column = (kind: string, shape: Shape = {}): AdminColumn => ({
  $meta: {
    kind,
    notNull: shape.notNull ?? true,
    primaryKey: shape.primaryKey ?? false,
    unique: shape.unique ?? false,
    index: shape.index ?? false,
    ...(shape.length === undefined ? {} : { length: shape.length }),
    ...(shape.values === undefined ? {} : { values: shape.values }),
  },
});

/** A bounded line of text — one line in a form, a `contains` the store can answer or refuse. */
const line = (shape: Shape = {}): AdminColumn => column('text', { length: 200, ...shape });
const key = (): AdminColumn => line({ primaryKey: true, index: true });
const optional = (kind: string): AdminColumn => column(kind, { notNull: false });

/**
 * Read-only by construction: no screen offers a create or an update, and a schema that refuses
 * every input is what any path that reached one would meet.
 */
const READ_ONLY_SCHEMA = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-admin',
    validate: () => ({
      issues: [{ message: 'an operator surface is read-only; use its actions' }],
    }),
  },
} as const;

function surface(name: string, columns: Readonly<Record<string, AdminColumn>>): AdminEntity {
  return {
    $name: name,
    $primaryKey: [Object.keys(columns)[0] ?? 'id'],
    $columns: columns,
    $schema: READ_ONLY_SCHEMA,
    $tenantColumn: null,
    $describe: () => ({
      columns: Object.keys(columns).map((property) => ({ property, references: null })),
    }),
  };
}

export const jobEntity: AdminEntity = surface(JOB_ENTITY.jobs, {
  id: key(),
  name: line({ index: true }),
  queue: line({ index: true }),
  state: line({ index: true, values: JOB_STATES }),
  attempt: column('integer'),
  maxAttempts: column('integer'),
  runAt: column('timestamptz'),
  createdAt: column('timestamptz', { index: true }),
  updatedAt: column('timestamptz'),
  tenantId: column('text', { notNull: false, length: 200, index: true }),
  lastError: optional('text'),
  lastErrorStack: optional('text'),
  progress: optional('jsonb'),
  // What the queue holds, ALREADY redacted by `@ultimat3/jobs` (`inspectJob`): every key the app
  // declared secret is replaced before the admin sees the value.
  input: optional('jsonb'),
  steps: optional('jsonb'),
  traceparent: optional('text'),
  enqueuedBy: optional('text'),
  claimedBy: optional('text'),
});

export const queueEntity: AdminEntity = surface(JOB_ENTITY.queues, {
  name: key(),
  ready: column('integer'),
  delayed: column('integer'),
  running: column('integer'),
  suspended: column('integer'),
  failed: column('integer'),
  dead: column('integer'),
  oldestReadyMs: column('integer'),
  paused: column('boolean', { index: true }),
  pausedAt: optional('timestamptz'),
});

export const taskEntity: AdminEntity = surface(JOB_ENTITY.tasks, {
  name: key(),
  cron: line(),
  tz: line(),
  catchUp: line(),
  enqueues: line(),
  lastFireAt: optional('timestamptz'),
  nextFireAt: optional('timestamptz'),
  paused: column('boolean', { index: true }),
});

export const workerEntity: AdminEntity = surface(JOB_ENTITY.workers, {
  id: key(),
  host: line(),
  queues: line(),
  concurrency: column('integer'),
  inFlight: column('integer'),
  startedAt: column('timestamptz'),
  heartbeatAt: column('timestamptz'),
});
