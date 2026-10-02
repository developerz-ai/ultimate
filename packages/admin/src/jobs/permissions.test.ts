// Read-only is not a mode: `job:read` sees every jobs screen and no control, and a forged post is
// refused by the same decision. An org-scoped operator sees that org's job rows and nothing of the
// fleet — no other org's job, no queue to pause — on a screen, a forged post and "all matching".

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobDriver } from '@ultimat3/jobs';
import { ask, jobsAdmin, MANAGER, READER, type Seeded, seedQueue } from './jobs-fixture';

const reader = jobsAdmin('/read', READER);
const manager = jobsAdmin('/manage', MANAGER);
const platform = { id: 'u-platform' };
const orgB = { id: 'u-org-b', orgId: 'org-b' };
let seeded: Seeded;

beforeEach(async () => {
  seeded = await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const SCREENS = [
  '/jobs',
  '/jobs/runs',
  '/jobs/runs?scope=dead',
  '/jobs/queues',
  '/jobs/tasks',
  '/jobs/workers',
] as const;

describe('job:read alone', () => {
  test('sees every screen, and not one control', async () => {
    const paths = [...SCREENS, `/jobs/runs/${seeded.ids.dead}`, `/jobs/queues/default`];
    for (const path of paths) {
      const answer = await ask(reader, platform, `/read${path}`);
      expect({ path, status: answer.status }).toEqual({ path, status: 200 });
      // No action button, no batch bar, no row checkbox: there is nothing this actor may run.
      expect({ path, button: answer.html.includes('value="job.') }).toEqual({
        path,
        button: false,
      });
      expect({ path, bar: answer.html.includes('id="x-admin-batch"') }).toEqual({
        path,
        bar: false,
      });
    }
    // The same pages, for an actor holding `job:manage`, carry the controls.
    const managed = await ask(manager, platform, `/manage/jobs/runs/${seeded.ids.dead}`);
    expect(managed.html).toContain('value="job.retry"');
    expect((await ask(manager, platform, '/manage/jobs/runs?scope=dead')).html).toContain(
      'id="x-admin-batch"',
    );
  });

  test('a forged retry is refused, 403, and the job stays dead', async () => {
    const forged = await ask(reader, platform, `/read/jobs/runs/${seeded.ids.dead}`, {
      _operation: 'action',
      name: 'job.retry',
    });
    expect(forged.status).toBe(403);
    expect(forged.html).toContain('admin:write');
    // One who may write in the admin but not manage jobs is refused on `job:manage` itself.
    const writer = jobsAdmin('/write', [...READER, 'admin:write']);
    const named = await ask(writer, platform, `/write/jobs/runs/${seeded.ids.dead}`, {
      _operation: 'action',
      name: 'job.retry',
    });
    expect(named.status).toBe(403);
    expect(named.html).toContain('job:manage');
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('dead');
    // A forged batch over every dead row is the same refusal.
    const batch = await ask(reader, platform, '/read/jobs/runs?scope=dead', {
      _operation: 'batch',
      name: 'job.retry',
      selection: 'all',
    });
    expect(batch.status).toBe(403);
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('dead');
  });

  test('retry is a dead row’s only: forged on a done row it is 409, and nothing runs', async () => {
    const forged = await ask(manager, platform, `/manage/jobs/runs/${seeded.ids.done}`, {
      _operation: 'action',
      name: 'job.retry',
    });
    expect(forged.status).toBe(409);
    expect((await seeded.operator.job(seeded.ids.done))?.state).toBe('done');
  });
});

describe('an org-scoped operator', () => {
  test('sees that org’s jobs only — a list, a search, a detail', async () => {
    const list = await ask(manager, orgB, '/manage/jobs/runs');
    expect(list.html).toContain(seeded.ids.ready);
    expect(list.html).not.toContain(seeded.ids.dead);
    const detail = await ask(manager, orgB, `/manage/jobs/runs/${seeded.ids.dead}`);
    expect(detail.status).toBe(404);
    const found = await ask(manager, orgB, `/manage/search?term=${seeded.ids.dead.slice(0, 13)}`);
    expect(found.html).not.toContain(seeded.ids.dead);
  });

  test('sees no fleet: no queue, no worker, no task, no figures — and cannot pause one', async () => {
    for (const path of ['/jobs/queues', '/jobs/workers', '/jobs/tasks']) {
      const page = await ask(manager, orgB, `/manage${path}`);
      expect(page.html).not.toContain('worker-1');
      expect(page.html).not.toContain(seeded.task);
      expect(page.html).not.toContain('href="/manage/jobs/queues/default"');
    }
    const overview = await ask(manager, orgB, '/manage/jobs');
    expect(overview.html).not.toContain('data-stat=');
    const pause = await ask(manager, orgB, '/manage/jobs/queues/default', {
      _operation: 'action',
      name: 'job.queue.pause',
    });
    // A row outside the actor's scope is no row: refused, whatever the action declares about rows.
    expect(pause.status).toBe(409);
    expect(await seeded.operator.pausedQueues()).toEqual([]);
    // `run-now` declares no `when` — and a row this actor cannot see is still not one it may act on.
    const depth = (await seeded.operator.list({})).length;
    const fire = await ask(manager, orgB, `/manage/jobs/tasks/${seeded.task}`, {
      _operation: 'action',
      name: 'job.task.run-now',
    });
    expect(fire.status).toBe(409);
    expect((await seeded.operator.list({})).length).toBe(depth);
  });

  test('"all matching" reaches that org’s rows only', async () => {
    // Org B's one job is `ready`, and so is one of org A's: a removal over every ready row of the
    // org-B operator's list leaves org A's where it is.
    const theirs = await seeded.driver.enqueue({
      name: seeded.name,
      queue: 'default',
      input: { item: 'org-a-ready' },
      idempotencyKey: 'org-a-ready',
      maxAttempts: 1,
      tenantId: 'org-a',
    });
    const before = await seeded.operator.list({ state: 'ready' });
    const answer = await ask(manager, orgB, '/manage/jobs/runs?scope=ready', {
      _operation: 'batch',
      name: 'job.remove',
      selection: 'all',
      _step: 'run',
      confirmation: 'x_jobs:all matching',
    });
    expect(answer.status).toBe(200);
    const after = await seeded.operator.list({ state: 'ready' });
    expect(before.map((row) => row.id)).toContain(seeded.ids.ready);
    expect(after.map((row) => row.id)).not.toContain(seeded.ids.ready);
    expect(after.map((row) => row.id)).toEqual([theirs.id]);
  });
});
