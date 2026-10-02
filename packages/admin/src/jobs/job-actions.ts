// Every change an operator makes to the queue, as an `AdminAction`: the button on a row, the batch
// bar's "checked" and "all matching", the MCP tool and the audit entry come from these declarations
// and from nothing jobs-specific. One permission gates them all — `job:manage`; reading is
// `job:read`, so an operator without the first sees every screen and no control.

import {
  cancelJob,
  getTask,
  type JobRecord,
  pauseQueue,
  promoteJob,
  removeJob,
  resumeQueue,
  retryFromStep,
} from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { AdminFilterInvalidError } from '../errors';
import type { AdminAction, AdminFilter, AdminMatchingResult, AdminRow } from '../registry';
import { JOB_ENTITY } from './job-entities';
import { bulkWhere, JOBS_RESOURCE } from './job-where';
import { jobsOperator } from './operator';

/** Reading the jobs screens. The admin's own `<noun>:read`, for every jobs resource. */
export const JOB_READ = 'job:read';
/** Every action on the queue. Without it the screens render no control and refuse the call. */
export const JOB_MANAGE = 'job:manage';

const LIVE: ReadonlySet<unknown> = new Set(['ready', 'delayed', 'running', 'suspended']);

const idOf = (input: Readonly<Record<string, unknown>>): string => String(input['id'] ?? '');

const waitingOnClock = (row: AdminRow): boolean => {
  const runAt = row['runAt'];
  return (
    (row['state'] === 'ready' || row['state'] === 'delayed') &&
    runAt instanceof Date &&
    runAt.getTime() > Date.now()
  );
};

/** A bulk verb over the list's `where`, held to the one state the action is for. */
function bulk(
  where: readonly AdminFilter[],
  states: readonly JobRecord['state'][],
  run: (filter: NonNullable<ReturnType<typeof bulkWhere>>) => Promise<AdminMatchingResult>,
): Promise<AdminMatchingResult> {
  const filter = bulkWhere(where);
  if (filter === null) return Promise.resolve({ affected: 0, remaining: 0 });
  if (!new Set<string>(states).has(filter.state)) {
    throw new AdminFilterInvalidError({
      entity: JOBS_RESOURCE,
      asked: `all matching in scope=${filter.state}`,
      cause: 'is not a state this action applies to',
      known: states.map((state) => `scope=${state}`),
    });
  }
  return run(filter);
}

const jobAction = (action: Omit<AdminAction, 'permission' | 'entity'>): AdminAction => ({
  ...action,
  permission: JOB_MANAGE,
  entity: JOB_ENTITY.jobs,
});

export const jobActions: readonly AdminAction[] = [
  jobAction({
    name: 'job.retry',
    // A dead letter, and only one: a finished `done` row run again is a second side effect.
    when: (row) => row['state'] === 'dead',
    batch: true,
    matching: ({ where }) =>
      bulk(where, ['dead'], (filter) => jobsOperator().introspect.requeueMany(filter)),
    async handle({ input }) {
      return { id: (await jobsOperator().introspect.requeue(idOf(input))).id };
    },
  }),
  jobAction({
    name: 'job.retry-from-step',
    when: (row) => row['state'] === 'dead' || row['state'] === 'failed',
    input: t.object({ step: t.string.min(1) }),
    async handle({ input }) {
      const step = String(input['step'] ?? '');
      return { id: (await retryFromStep(jobsOperator().driver, idOf(input), step))?.id ?? null };
    },
  }),
  jobAction({
    name: 'job.run-now',
    when: waitingOnClock,
    batch: true,
    matching: ({ where }) =>
      bulk(where, ['delayed', 'ready'], (filter) => jobsOperator().introspect.promoteMany(filter)),
    async handle({ input }) {
      return { id: (await promoteJob(jobsOperator().driver, idOf(input))).id };
    },
  }),
  jobAction({
    name: 'job.cancel',
    when: (row) => LIVE.has(row['state']),
    async handle({ input }) {
      return { id: (await cancelJob(jobsOperator().driver, idOf(input)))?.id ?? null };
    },
  }),
  jobAction({
    name: 'job.remove',
    destructive: true,
    // A running job is a worker's: cancel it first, as the store itself insists.
    when: (row) => row['state'] !== 'running',
    batch: true,
    matching: ({ where }) =>
      bulk(
        where,
        ['ready', 'delayed', 'suspended', 'done', 'failed', 'dead', 'cancelled'],
        (filter) => jobsOperator().introspect.removeMany(filter),
      ),
    async handle({ input }) {
      return { id: (await removeJob(jobsOperator().driver, idOf(input)))?.id ?? null };
    },
  }),
];

const fleetAction = (
  entity: string,
  action: Omit<AdminAction, 'permission' | 'entity'>,
): AdminAction => ({ ...action, permission: JOB_MANAGE, entity });

export const queueActions: readonly AdminAction[] = [
  fleetAction(JOB_ENTITY.queues, {
    name: 'job.queue.pause',
    when: (row) => row['paused'] !== true,
    async handle({ input }) {
      await pauseQueue(jobsOperator().driver, idOf(input));
      return { queue: idOf(input), paused: true };
    },
  }),
  fleetAction(JOB_ENTITY.queues, {
    name: 'job.queue.resume',
    when: (row) => row['paused'] === true,
    async handle({ input }) {
      await resumeQueue(jobsOperator().driver, idOf(input));
      return { queue: idOf(input), paused: false };
    },
  }),
];

export const taskActions: readonly AdminAction[] = [
  fleetAction(JOB_ENTITY.tasks, {
    name: 'job.task.pause',
    when: (row) => row['paused'] !== true,
    async handle({ input }) {
      await jobsOperator().introspect.pauseTask(idOf(input));
      return { task: idOf(input), paused: true };
    },
  }),
  fleetAction(JOB_ENTITY.tasks, {
    name: 'job.task.resume',
    when: (row) => row['paused'] === true,
    async handle({ input }) {
      await jobsOperator().introspect.resumeTask(idOf(input));
      return { task: idOf(input), paused: false };
    },
  }),
  fleetAction(JOB_ENTITY.tasks, {
    name: 'job.task.run-now',
    async handle({ input }) {
      // The row came from the registry, so a task that is gone is a task renamed since the page.
      const handle = getTask(idOf(input));
      const jobs = handle === undefined ? [] : await handle.enqueue();
      return { task: idOf(input), jobs: jobs.length };
    },
  }),
];
