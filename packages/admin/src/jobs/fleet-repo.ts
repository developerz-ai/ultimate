// The queues, the tasks and the workers as `AdminRepo`s. Each is a SMALL set the store answers
// whole — one `stats()`, one registry read — so a page is that set, filtered by the package's one
// predicate evaluator (`outsideRowScope`), ordered and cut by keyset here. Read-only.

import { assert } from '@ultimat3/core';
import { inspectManifest, nextTaskRun, registeredJobs } from '@ultimat3/jobs';
import type { AdminFilter, AdminListQuery, AdminRepo, AdminRow, KeysetBound } from '../registry';
import { outsideRowScope } from '../row-scope-write';
import { jobsOperator } from './operator';

type Load = () => Promise<readonly AdminRow[]>;

const comparable = (value: unknown): string | number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
};

const absent = (value: unknown): boolean => value === null || value === undefined;

/**
 * Code-unit order, never a collation: the same set reads the same way on every machine. NULL is
 * the LARGEST value — last ascending, first descending — as the database orders a nullable sort
 * key and as `repo-entity.ts` seeks one; it read as `''` here, which sorted it as a zero.
 */
const order = (a: unknown, b: unknown): number => {
  if (absent(a) || absent(b)) return absent(a) && absent(b) ? 0 : absent(a) ? 1 : -1;
  const x = comparable(a);
  const y = comparable(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * A cursor carries its value as text (`pagination.ts`), or `null` for a row that held none; read
 * back as the type of the row it is compared with. A `null` bound stays `null` — `new Date(null)`
 * is the epoch and `new Date('')` is NaN, and either made the page after a NULL row the wrong one.
 */
const boundValue = (row: AdminRow, bound: KeysetBound, field: string): unknown => {
  if (bound.value === null) return null;
  const held = row[field];
  if (held instanceof Date) return new Date(bound.value);
  if (typeof held === 'number') return Number(bound.value);
  if (typeof held === 'boolean') return bound.value === 'true';
  return bound.value;
};

export function fleetRepo(idField: string, load: Load): AdminRepo<AdminRow> {
  const matching = async (where: readonly AdminFilter[] | undefined): Promise<AdminRow[]> =>
    (await load()).filter((row) => outsideRowScope(row, where ?? []) === null);

  /** `(sort value, id)` against a bound, in the query's own direction. */
  const versus = (row: AdminRow, bound: KeysetBound, query: AdminListQuery): number => {
    const sign = query.sort.direction === 'asc' ? 1 : -1;
    const field = query.sort.field;
    const primary = order(row[field], boundValue(row, bound, field));
    return sign * (primary !== 0 ? primary : order(row[idField], bound.id));
  };

  const readOnly = async (): Promise<never> => {
    assert(
      false,
      'a queue, task or worker row was written through the admin repo, and none offers a write',
      'change it through its actions: admin.action.job.queue.pause, admin.action.job.task.run-now, …',
    );
  };

  return {
    async list(query) {
      const sign = query.sort.direction === 'asc' ? 1 : -1;
      const rows = (await matching(query.where)).sort(
        (a, b) =>
          sign * (order(a[query.sort.field], b[query.sort.field]) || order(a[idField], b[idField])),
      );
      const { after, before } = query;
      if (before !== undefined) {
        const earlier = rows.filter((row) => versus(row, before, query) < 0);
        return earlier.slice(Math.max(0, earlier.length - query.limit));
      }
      const later =
        after === undefined ? rows : rows.filter((row) => versus(row, after, query) > 0);
      return later.slice(0, query.limit);
    },
    async find(id) {
      return (await load()).find((row) => row[idField] === id) ?? null;
    },
    async count(where) {
      return (await matching(where)).length;
    },
    create: readOnly,
    update: readOnly,
    destroy: readOnly,
  };
}

const at = (ms: number | undefined): Date | null => (ms === undefined ? null : new Date(ms));

/** Every queue with rows, every paused one and every one a registered job names. */
export const queueRepo = fleetRepo('name', async () => {
  const { driver, introspect } = jobsOperator();
  const [stats, paused] = await Promise.all([driver.stats(), introspect.pausedQueues()]);
  const pausedAt = new Map(paused.map((entry) => [entry.name, entry.pausedAt]));
  const names = new Set([
    ...stats.map((queue) => queue.queue),
    ...pausedAt.keys(),
    ...registeredJobs().map((handle) => handle.queue),
  ]);
  return [...names].map((name) => {
    const queue = stats.find((one) => one.queue === name);
    return {
      name,
      ready: queue?.ready ?? 0,
      delayed: queue?.delayed ?? 0,
      running: queue?.running ?? 0,
      suspended: queue?.suspended ?? 0,
      failed: queue?.failed ?? 0,
      dead: queue?.dead ?? 0,
      oldestReadyMs: queue?.oldestReadyMs ?? 0,
      paused: pausedAt.has(name),
      pausedAt: at(pausedAt.get(name)),
    };
  });
});

/** Every registered task: its schedule, its zone, the last occurrence that fired and the next. */
export const taskRepo = fleetRepo('name', async () => {
  const { introspect } = jobsOperator();
  const [paused, fires] = await Promise.all([introspect.pausedTasks(), introspect.taskFires()]);
  const pausedNames = new Set(paused.map((entry) => entry.name));
  const now = new Date();
  return inspectManifest().tasks.map((task) => ({
    name: task.name,
    cron: task.cron,
    tz: task.tz,
    catchUp: task.catchUp,
    enqueues: task.enqueues.join(', '),
    lastFireAt: at(fires.find((fire) => fire.task === task.name)?.firedAt),
    nextFireAt: nextTaskRun(task, now),
    paused: pausedNames.has(task.name),
  }));
});

/** Every worker whose heartbeat has not expired. */
export const workerRepo = fleetRepo('id', async () => {
  const { introspect } = jobsOperator();
  return (await introspect.workers()).map((worker) => ({
    id: worker.id,
    host: worker.host,
    queues: worker.queues.join(', '),
    concurrency: worker.concurrency,
    inFlight: worker.inFlight.length,
    startedAt: new Date(worker.startedAt),
    heartbeatAt: new Date(worker.heartbeatAt),
  }));
});
