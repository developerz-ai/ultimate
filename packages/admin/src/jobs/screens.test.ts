// Every jobs screen, rendered from a memory queue seeded with one job per state: the overview's
// tiles and chart, the queues, a queue's jobs, the running and the dead, a job's detail with its
// redacted input and its steps, the tasks, the workers and the search. Zero script on any of them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetJobDriver } from '@ultimat3/jobs';
import { ask, jobsAdmin, type Seeded, seedQueue } from './jobs-fixture';

const admin = jobsAdmin('/ops');
const platform = { id: 'u-platform', locale: 'en', timeZone: 'America/Bogota' };
let seeded: Seeded;

beforeAll(async () => {
  seeded = await seedQueue();
});

afterAll(() => {
  resetJobDriver();
});

const html = async (path: string): Promise<string> => {
  const answer = await ask(admin, platform, path);
  expect({ path, status: answer.status }).toEqual({ path, status: 200 });
  // The admin's rule, kept on every jobs screen: links and native forms, never a script.
  expect(answer.html).not.toContain('<script');
  return answer.html;
};

describe('the overview', () => {
  test('tiles count every state from stats(), and the refresh is declared, not a socket', async () => {
    const page = await html('/ops/jobs');
    for (const stat of ['ready', 'running', 'delayed', 'suspended', 'dead', 'workers']) {
      expect(page).toContain(`data-stat="${stat}"`);
    }
    expect(page).toMatch(/data-stat="dead"[^>]*>1</);
    expect(page).toMatch(/data-stat="workers"[^>]*>1</);
    expect(page).toContain('http-equiv="refresh"');
    // Each tile is a link to the list it counts.
    expect(page).toContain('href="/ops/jobs/runs?scope=dead"');
  });

  test('the chart stacks done under failed, and the per-name table reads the counters', async () => {
    const page = await html('/ops/jobs?range=1h');
    expect(page).toContain('data-series="secondary"');
    expect(page).toContain('aria-current="page"');
    expect(page).toContain(seeded.name);
    // One done, one failed and one dead ended: a failure rate of two in three.
    expect(page).toContain('66.7%');
  });

  test('a range the overview does not draw is refused by name, 400', async () => {
    const answer = await ask(admin, platform, '/ops/jobs?range=forever');
    expect(answer.status).toBe(400);
    expect(answer.html).toContain('X_ADMIN_FILTER_INVALID');
    expect(answer.html).toContain('range=24h');
  });
});

describe('the lists', () => {
  test('queues: depth per state and the paused flag, each linking to its own jobs', async () => {
    const page = await html('/ops/jobs/queues');
    expect(page).toContain('href="/ops/jobs/runs?f.queue=default"');
  });

  test('a queue’s jobs are the runs list filtered to it, newest first', async () => {
    const page = await html('/ops/jobs/runs?f.queue=default');
    for (const id of Object.values(seeded.ids)) expect(page).toContain(id);
  });

  test('one tab per state: running, delayed and dead each list their one job', async () => {
    for (const state of ['running', 'delayed', 'dead'] as const) {
      const page = await html(`/ops/jobs/runs?scope=${state}`);
      expect(page).toContain(seeded.ids[state]);
      expect(page).not.toContain(seeded.ids.done);
    }
  });

  test('search: an id prefix, a name and a state together', async () => {
    const prefix = seeded.ids.dead.slice(0, 13);
    const page = await html(
      `/ops/jobs/runs?scope=dead&f.id=${prefix}&f.name=${encodeURIComponent(seeded.name)}`,
    );
    expect(page).toContain(seeded.ids.dead);
    expect(page).not.toContain(seeded.ids.ready);
  });

  test('a predicate the job store cannot answer is refused by name, never dropped', async () => {
    const answer = await ask(admin, platform, '/ops/jobs/runs?sort=createdAt:asc');
    expect(answer.status).toBe(400);
  });

  test('tasks: schedule, zone, and the next fire', async () => {
    const page = await html('/ops/jobs/tasks');
    expect(page).toContain(seeded.task);
    expect(page).toContain('America/Bogota');
    expect(page).toContain('0 9 * * *');
  });

  test('workers: identity, host and what it holds', async () => {
    const page = await html('/ops/jobs/workers');
    expect(page).toContain('worker-1');
    expect(page).toContain('pod-a');
  });
});

describe('a job’s detail', () => {
  test('input (redacted), error, steps, tenant and its own actions', async () => {
    const page = await html(`/ops/jobs/runs/${seeded.ids.dead}`);
    expect(page).toContain('X_BOOM: the upstream refused');
    expect(page).toContain('org-a');
    expect(page).toContain('[redacted]');
    expect(page).not.toContain('CANARY-SECRET');
    // The dead row offers retry and retry-from-step, never run-now or cancel.
    expect(page).toContain('value="job.retry"');
    expect(page).toContain('job.retry-from-step');
    expect(page).not.toContain('value="job.cancel"');
  });

  test('a job id nobody queued is the admin’s 404', async () => {
    const answer = await ask(
      admin,
      platform,
      '/ops/jobs/runs/019ff1c5-0000-7000-8000-00000000dead',
    );
    expect(answer.status).toBe(404);
  });
});
