// The jobs dashboard as `defineAdmin()` input: four resources over the queue's operator surface,
// each an ordinary `AdminResourceOptions` — a `repo:`, scopes, a row scope, computed columns,
// sections — and `job-actions.ts`'s actions, attached by `entity` as an app's are. `defineAdmin`
// declares them for every app, so `/admin/jobs/*` exists with no app code.

import { JOB_STATES } from '@ultimat3/jobs';
import type { AdminActor } from '../authz';
import { listHref } from '../list-request';
import type { AdminAction, AdminEntity, AdminFilter } from '../registry';
import { type AdminResourceOptions, adminResource } from '../resource';
import type { AdminRowScope, AdminScopeOptions } from '../resource-list';
import { queueRepo, taskRepo, workerRepo } from './fleet-repo';
import { jobActions, queueActions, taskActions } from './job-actions';
import { JOB_ENTITY, jobEntity, queueEntity, taskEntity, workerEntity } from './job-entities';
import {
  labelled,
  QUEUE_LABELS,
  RUN_LABELS,
  SCOPE_LABELS,
  TASK_LABELS,
  WORKER_LABELS,
} from './job-labels';
import { JOB_SORT, jobRepo } from './job-repo';

/** The permission noun every jobs resource shares: `job:read` lists any of them. */
export const JOB_PERMISSION_NOUN = 'job';
/** Where the jobs screens sit under the admin's base path. The overview is this path itself. */
export const JOBS_PATH = '/jobs';
export const JOBS_GROUP = 'admin.group.jobs';

/**
 * An org-scoped operator — an actor with an `orgId` — sees that org's job rows and nothing else.
 * A platform operator is the actor without one, and sees every row.
 */
export const jobRowScope: AdminRowScope = (actor: AdminActor): readonly AdminFilter[] =>
  actor.orgId === undefined ? [] : [{ field: 'tenantId', op: 'eq', value: actor.orgId }];

/**
 * Queues, tasks and workers are the FLEET, shared by every tenant: an org-scoped operator who
 * paused a queue would pause it for every org. So they are a platform operator's rows only — the
 * predicate below holds for no row, because every row of these three has a key.
 */
const platformOnly =
  (key: string): AdminRowScope =>
  (actor) =>
    actor.orgId === undefined ? [] : [{ field: key, op: 'is-null', value: true }];

/** One tab per state, plus every row. Counts are the overview's tiles (`stats()`), not the tabs. */
const stateScopes: Readonly<Record<string, AdminScopeOptions>> = Object.fromEntries([
  ['all', { where: [], default: true, labelKey: SCOPE_LABELS.all }],
  ...JOB_STATES.map((state) => [
    state,
    { where: [{ field: 'state', op: 'eq', value: state }], labelKey: SCOPE_LABELS[state] },
  ]),
]);

/** A choice the store answers by equality — never the `contains` a free-text column defaults to. */
const exact = { type: 'enum', sortable: false } as const;
const unsorted = { sortable: false } as const;
const unsearched = { searchable: false } as const;

function runsOptions(): AdminResourceOptions {
  return {
    repo: jobRepo,
    path: `${JOBS_PATH}/runs`,
    titleKey: RUN_LABELS.title,
    permission: JOB_PERMISSION_NOUN,
    group: JOBS_GROUP,
    // The list's search box is the label's filter: an id pasted from a log line, by its prefix.
    labelField: 'id',
    fields: labelled(RUN_LABELS.fields, {
      id: { searchable: true, sortable: false, hintKey: 'admin.jobs.hint.id' },
      name: exact,
      queue: exact,
      tenantId: exact,
      attempt: unsorted,
      maxAttempts: unsorted,
      runAt: unsorted,
      updatedAt: unsorted,
      // Free text the store cannot search: the admin's search asks only what it can answer.
      lastError: unsearched,
      lastErrorStack: unsearched,
      traceparent: unsearched,
      enqueuedBy: unsearched,
      claimedBy: unsearched,
    }),
    listFields: ['id', 'name', 'state', 'queue', 'attempt', 'runAt'],
    columns: {
      // `progress` itself is the column (JSON, on the detail page); the list shows `done / total`.
      completed: {
        value: (row) => {
          const progress = row['progress'];
          if (typeof progress !== 'object' || progress === null) return '';
          const { done, total } = progress as { done?: unknown; total?: unknown };
          return `${String(done)} / ${String(total)}`;
        },
        render: 'truncate',
        labelKey: RUN_LABELS.columns.completed,
      },
      error: {
        value: (row) => row['lastError'],
        render: 'truncate',
        labelKey: RUN_LABELS.columns.error,
      },
    },
    scopes: stateScopes,
    rows: jobRowScope,
    sections: [
      {
        titleKey: 'admin.jobs.section.run',
        fields: ['name', 'queue', 'state', 'attempt', 'maxAttempts', 'runAt', 'createdAt'],
      },
      { titleKey: 'admin.jobs.section.failure', fields: ['lastError', 'lastErrorStack'] },
      { titleKey: 'admin.jobs.section.work', fields: ['input', 'progress', 'steps'] },
      {
        titleKey: 'admin.jobs.section.trace',
        fields: ['tenantId', 'traceparent', 'enqueuedBy', 'claimedBy', 'updatedAt'],
      },
    ],
    defaultSort: JOB_SORT,
    pageSize: 50,
    operations: ['list', 'detail', 'search'],
  };
}

/** The whole dashboard as `defineAdmin` input, its links under `basePath`. */
export function jobsAdmin(basePath: string): {
  readonly entities: readonly AdminEntity[];
  readonly resources: Readonly<Record<string, AdminResourceOptions>>;
  readonly actions: readonly AdminAction[];
} {
  // Built once more here only to spell links through the list's own URL grammar (`listHref`).
  const runs = adminResource(jobEntity, runsOptions());
  const runsOf = (field: string, value: string): string =>
    listHref(basePath, runs, { filters: [{ field, op: 'eq', value }] });
  const fleet = {
    permission: JOB_PERMISSION_NOUN,
    group: JOBS_GROUP,
    operations: ['list', 'detail', 'search'],
  } as const;
  return {
    entities: [jobEntity, queueEntity, taskEntity, workerEntity],
    resources: {
      [JOB_ENTITY.jobs]: runsOptions(),
      [JOB_ENTITY.queues]: {
        ...fleet,
        repo: queueRepo,
        path: `${JOBS_PATH}/queues`,
        titleKey: QUEUE_LABELS.title,
        fields: labelled(QUEUE_LABELS.fields),
        labelField: 'name',
        listFields: ['name', 'ready', 'delayed', 'running', 'dead', 'failed', 'paused'],
        columns: {
          oldest: {
            value: (row) => `${String(row['oldestReadyMs'])} ms`,
            render: 'truncate',
            labelKey: QUEUE_LABELS.columns.oldest,
          },
          jobs: {
            value: (row) => ({
              href: runsOf('queue', String(row['name'])),
              label: String(row['name']),
            }),
            render: 'link',
            labelKey: QUEUE_LABELS.columns.jobs,
          },
        },
        defaultSort: { field: 'name', direction: 'asc' },
        rows: platformOnly('name'),
      },
      [JOB_ENTITY.tasks]: {
        ...fleet,
        repo: taskRepo,
        path: `${JOBS_PATH}/tasks`,
        titleKey: TASK_LABELS.title,
        fields: labelled(TASK_LABELS.fields),
        labelField: 'name',
        listFields: ['name', 'cron', 'tz', 'lastFireAt', 'nextFireAt', 'paused'],
        defaultSort: { field: 'name', direction: 'asc' },
        rows: platformOnly('name'),
      },
      [JOB_ENTITY.workers]: {
        ...fleet,
        repo: workerRepo,
        path: `${JOBS_PATH}/workers`,
        titleKey: WORKER_LABELS.title,
        fields: labelled(WORKER_LABELS.fields),
        labelField: 'id',
        listFields: ['id', 'host', 'queues', 'inFlight', 'concurrency', 'startedAt'],
        columns: {
          heartbeat: {
            value: (row) => row['heartbeatAt'],
            render: 'relative-time',
            labelKey: WORKER_LABELS.columns.heartbeat,
          },
          running: {
            value: (row) => ({
              href: listHref(basePath, runs, { scope: 'running' }),
              label: String(row['inFlight']),
            }),
            render: 'link',
            labelKey: WORKER_LABELS.columns.running,
          },
        },
        defaultSort: { field: 'id', direction: 'asc' },
        rows: platformOnly('id'),
      },
    },
    actions: [...jobActions, ...queueActions, ...taskActions],
  };
}
