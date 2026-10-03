// Each queue action through the admin's own gate: which row it applies to, what its handler does to
// the queue, and "all matching" as the store's own bounded bulk verb — refused when the list it is
// asked over is not one that verb can say.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobDriver } from '@ultimat3/jobs';
import { actionInputFields } from '../action-input';
import { invokeRowAction } from '../action-row';
import type { AdminApp } from '../admin';
import { runAdminBatch } from '../batch';
import type { AdminResource } from '../resource';
import { JOB_ENTITY } from './job-entities';
import { RETRY_STEP_LABEL } from './job-labels';
import { jobsAdmin, type Seeded, seedQueue } from './jobs-fixture';

let admin: AdminApp;
let seeded: Seeded;
let runs: AdminResource;
beforeAll(() => {
  admin = jobsAdmin('/acts');
  runs = admin.resource(JOB_ENTITY.jobs);
});
const ctx = () => admin.ctx({ actor: { id: 'u-op' }, requestId: 'acts' });

beforeEach(async () => {
  seeded = await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const action = (name: string) => {
  const found = admin.resources.flatMap((one) => one.actions).find((one) => one.name === name);
  return found ?? expect.unreachable(`no action ${name}`);
};

const run = (resource: string, name: string, id: string, input = {}) =>
  invokeRowAction({
    resource: admin.resource(resource),
    action: action(name),
    id,
    ctx: ctx(),
    input,
    confirmation: `${resource}:${id}`,
  });
describe('one row', () => {
  test('run-now makes a delayed job due; cancel stops a live one; remove deletes a finished one', async () => {
    expect((await run(JOB_ENTITY.jobs, 'job.run-now', seeded.ids.delayed)).ok).toBe(true);
    expect((await seeded.operator.job(seeded.ids.delayed))?.state).toBe('ready');
    expect((await run(JOB_ENTITY.jobs, 'job.cancel', seeded.ids.suspended)).ok).toBe(true);
    expect((await seeded.operator.job(seeded.ids.suspended))?.state).toBe('cancelled');
    expect((await run(JOB_ENTITY.jobs, 'job.remove', seeded.ids.done)).ok).toBe(true);
    expect(await seeded.operator.job(seeded.ids.done)).toBeUndefined();
  });

  test('each applies to its own rows only: no run-now on a due job, no remove on a running one', async () => {
    const due = await run(JOB_ENTITY.jobs, 'job.run-now', seeded.ids.ready);
    expect(!due.ok && due.kind).toBe('not-applicable');
    const held = await run(JOB_ENTITY.jobs, 'job.remove', seeded.ids.running);
    expect(!held.ok && held.kind).toBe('not-applicable');
    const finished = await run(JOB_ENTITY.jobs, 'job.cancel', seeded.ids.done);
    expect(!finished.ok && finished.kind).toBe('not-applicable');
  });

  test('retry from a step is a form whose one box is labelled at the derived key', async () => {
    expect(actionInputFields(action('job.retry-from-step')).map((one) => one.labelKey)).toEqual([
      RETRY_STEP_LABEL,
    ]);
    const missing = await run(JOB_ENTITY.jobs, 'job.retry-from-step', seeded.ids.dead, {});
    expect(!missing.ok && missing.kind).toBe('invalid');
    expect(
      (await run(JOB_ENTITY.jobs, 'job.retry-from-step', seeded.ids.failed, { step: 'send' })).ok,
    ).toBe(true);
    expect((await seeded.operator.job(seeded.ids.failed))?.state).toBe('ready');
  });

  test('a task paused, resumed and run now from its row', async () => {
    expect((await run(JOB_ENTITY.tasks, 'job.task.pause', seeded.task)).ok).toBe(true);
    expect((await seeded.operator.pausedTasks()).map((one) => one.name)).toEqual([seeded.task]);
    const twice = await run(JOB_ENTITY.tasks, 'job.task.pause', seeded.task);
    expect(!twice.ok && twice.kind).toBe('not-applicable');
    expect((await run(JOB_ENTITY.tasks, 'job.task.resume', seeded.task)).ok).toBe(true);
    expect(await seeded.operator.pausedTasks()).toEqual([]);
    const before = (await seeded.operator.list({ state: 'ready' })).length;
    expect((await run(JOB_ENTITY.tasks, 'job.task.run-now', seeded.task)).ok).toBe(true);
    expect((await seeded.operator.list({ state: 'ready' })).length).toBe(before + 1);
  });
});

describe('"all matching" is the store’s own bulk verb', () => {
  test('retry over the dead tab requeues every dead row in one call', async () => {
    const result = await runAdminBatch({
      resource: runs,
      action: action('job.retry'),
      ctx: ctx(),
      selection: { kind: 'all', request: { scope: 'dead' } },
    });
    expect(result.ok && { done: result.done, remaining: result.remaining }).toEqual({
      done: 1,
      remaining: 0,
    });
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('ready');
  });

  test('run-now over the delayed tab, remove over the cancelled tab', async () => {
    const promoted = await runAdminBatch({
      resource: runs,
      action: action('job.run-now'),
      ctx: ctx(),
      selection: { kind: 'all', request: { scope: 'delayed' } },
    });
    expect(promoted.ok && promoted.done).toBe(1);
    const removed = await runAdminBatch({
      resource: runs,
      action: action('job.remove'),
      ctx: ctx(),
      selection: { kind: 'all', request: { scope: 'cancelled' } },
      confirmation: 'x_jobs:all matching',
    });
    expect(removed.ok && removed.done).toBe(1);
    expect(await seeded.operator.job(seeded.ids.cancelled)).toBeUndefined();
  });

  test('a tab the action is not for, or no tab at all, is refused by name', async () => {
    const attempt = (name: string, scope: string | undefined) =>
      runAdminBatch({
        resource: runs,
        action: action(name),
        ctx: ctx(),
        selection: { kind: 'all', request: scope === undefined ? {} : { scope } },
        confirmation: 'x_jobs:all matching',
      }).then(
        () => 'ran',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(await attempt('job.retry', 'done')).toBe('X_ADMIN_FILTER_INVALID');
    expect(await attempt('job.remove', undefined)).toBe('X_ADMIN_FILTER_INVALID');
    expect((await seeded.operator.job(seeded.ids.done))?.state).toBe('done');
  });
});
