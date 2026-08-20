// `defaultDevSources()`'s registry-backed half: every source that reads a real framework registry
// rather than a `hooks` entry. `data.test.ts` owns the unwired/hook/policy-matrix half.
//
// Driven against the REAL registries — `@ultimat3/render`'s route table, `@ultimat3/jobs`' job and
// task registries and its memory driver, `@ultimat3/entity`'s registry, `@ultimat3/cache`'s
// dependency graph — because the whole class of bug this file exists to catch is a projection
// reading a field the registry does not publish under that name. A fake source would agree with
// whatever this file believed the registry's shape to be, which is the belief under test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerDependent, unregisterDependent } from '@ultimat3/cache';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import type { JobDriver } from '@ultimat3/jobs';
import {
  createMemoryDriver,
  job,
  resetJobDriver,
  resetJobs,
  resetTasks,
  setJobDriver,
  t,
  task,
} from '@ultimat3/jobs';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { defaultDevSources } from './data';

const widget = entity('dev_facts_widget', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    createdAt: timestamp().defaultNow(),
  },
});

let driver: JobDriver;

beforeAll(() => {
  resetJobs();
  resetTasks();
  driver = createMemoryDriver();
  setJobDriver(driver);
});

afterAll(async () => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  clearRoutes();
  clearRegistry();
  await driver.close?.();
});

describe('routes()', () => {
  test('the route table reaches the panel with its path and its offline/hydrate strategies', async () => {
    clearRoutes();
    registerRoute({
      file: 'apps/web/app/widgets/page.tsx',
      config: defineRoute({
        render: 'ssr',
        offline: 'precache',
        hydrate: 'visible',
        budget: { js: '12kb', lcp: 2_000 },
        revalidate: { tags: [{ entity: 'dev_facts_widget' }], ttl: 60 },
        meta: () => ({ title: 'Widgets' }),
      }),
    });

    const facts = await defaultDevSources().routes();
    const fact = facts.find((candidate) => candidate.path === '/widgets');
    expect(fact).toBeDefined();
    if (fact === undefined) return;

    // The whole fact, field by field, against a route whose every declared value differs from the
    // fallback the bag reads used to publish: `render: 'stream'`, `budget: {}`, tags `[]`.
    expect(fact).toEqual({
      path: '/widgets',
      // `RouteDescriptor.mode`. Read as `route['render']` this was `stream` for every route in
      // every app, which is the reading the panel's own `byRenderMode` count was built on.
      render: 'ssr',
      offline: 'precache',
      hydrate: 'visible',
      // No `handler` on a `RouteDescriptor`, so the FILE is what names the row — the panel would
      // otherwise show a blank cell for every route in the table.
      handler: 'apps/web/app/widgets/page.tsx',
      // Two flat descriptor fields, `budgetJs`/`budgetLcp` — never a nested `budget` bag.
      budget: { js: '12kb', lcp: 2_000 },
      // Already flattened to cache keys by the descriptor; `revalidate.tags` is not a shape it has.
      revalidateTags: ['dev_facts_widget'],
    });
  });

  test('an empty route table is an empty list, not a throw', async () => {
    clearRoutes();
    expect(await defaultDevSources().routes()).toEqual([]);
  });
});

describe('jobDefs()', () => {
  test('the job registry reaches the panel with its queue and its retry policy', async () => {
    job({
      name: 'dev_facts_digest',
      tenant: 'none',
      queue: 'mail',
      input: t.object({ orgId: t.string }),
      idempotencyKey: (input: { orgId: string }) => `digest:${input.orgId}`,
      retry: { attempts: 5, backoff: 'linear', delay: 1_000 },
      run: () => Promise.resolve(),
    });

    const facts = await defaultDevSources().jobDefs();
    const fact = facts.find((candidate) => candidate.name === 'dev_facts_digest');
    expect(fact).toBeDefined();
    if (fact === undefined) return;

    expect(fact.queue).toBe('mail');
    // 5 and 'linear' are the DECLARED values, so a projection that lost the retry object would
    // answer the 1/'exponential' defaults instead and read as a correct row.
    expect(fact.retry).toEqual({ attempts: 5, backoff: 'linear' });
    // Step names are chosen inside `run()`, so a descriptor cannot know them.
    expect(fact.steps).toEqual([]);
    // `job()` refuses a definition with no `idempotencyKey`, so every registered job is safe to
    // replay. The panel read the DEFINITION's key off the descriptor and called all of them unsafe.
    expect(fact.idempotent).toBe(true);
  });
});

describe('tasks()', () => {
  test('the schedule reaches the panel with its cron and its zone', async () => {
    const digest = job({
      name: 'dev_facts_sweep_job',
      tenant: 'none',
      input: t.object({ day: t.string }),
      idempotencyKey: (input: { day: string }) => `sweep:${input.day}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({
      name: 'dev_facts_sweep',
      cron: '0 3 * * *',
      tz: 'Europe/Madrid',
      enqueue: () => [[digest, { day: '2026-08-19' }]],
    });

    const facts = await defaultDevSources().tasks();
    const fact = facts.find((candidate) => candidate.name === 'dev_facts_sweep');
    expect(fact).toBeDefined();
    if (fact === undefined) return;

    expect(fact.cron).toBe('0 3 * * *');
    // No zone is the bug `task()` refuses at declaration; the panel must not lose it afterwards.
    expect(fact.tz).toBe('Europe/Madrid');
    // `inspectManifest()` with no scheduler cannot compute a next occurrence.
    expect(fact.nextRunAt).toBeNull();
  });
});

describe('queues() and jobRuns()', () => {
  test('a queue with work in it reports its depth, and a claimed job is running', async () => {
    await driver.enqueue({
      name: 'dev_facts_digest',
      queue: 'mail',
      input: { orgId: 'org-1' },
      idempotencyKey: 'dev_facts:queued',
      maxAttempts: 3,
    });
    await driver.enqueue({
      name: 'dev_facts_digest',
      queue: 'mail',
      input: { orgId: 'org-2' },
      idempotencyKey: 'dev_facts:claimed',
      maxAttempts: 3,
    });
    const claimed = await driver.claim({
      queues: ['mail'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-1',
    });
    expect(claimed).toHaveLength(1);

    const queues = await defaultDevSources().queues();
    const mail = queues.find((queue) => queue.name === 'mail');
    expect(mail).toBeDefined();
    if (mail === undefined) return;

    // `depth` is ready + delayed — the work still waiting. The claimed one is counted as running,
    // and counting it in both would tell an operator the queue is not draining.
    expect(mail.depth).toBe(1);
    expect(mail.running).toBe(1);
    expect(mail.failed).toBe(0);
    expect(mail.deadLetter).toBe(0);
  });

  test('a run carries its step trace, which is the panel’s whole question', async () => {
    const runId = (await driver.introspect?.list({ name: 'dev_facts_digest', limit: 10 }))?.[0]
      ?.runId;
    expect(typeof runId).toBe('string');
    if (typeof runId !== 'string') return;

    await driver.steps.put({
      runId,
      name: 'fetch-rows',
      status: 'failed',
      startedAt: 1_000,
      completedAt: 1_400,
      attempts: 2,
      error: 'boom',
    });

    const runs = await defaultDevSources().jobRuns();
    const withStep = runs.find((candidate) => candidate.steps.length > 0);
    expect(withStep).toBeDefined();
    if (withStep === undefined) return;

    expect(withStep.queue).toBe('mail');
    // The queue's vocabulary is `ready|running|…`; the panel's is four words. A claimed job is
    // `running` in both, and the mapping is what this pins.
    expect(['running', 'ok', 'failed', 'dead']).toContain(withStep.status);
    expect(withStep.steps[0]).toEqual({
      name: 'fetch-rows',
      status: 'failed',
      attempt: 2,
      durationMs: 400,
      error: 'boom',
    });
  });

  test('a job with no queue at all refuses rather than reporting an empty queue list', async () => {
    resetJobDriver();
    try {
      const noQueues = await defaultDevSources()
        .queues()
        .catch((error: unknown) => error);
      const noRuns = await defaultDevSources()
        .jobRuns()
        .catch((error: unknown) => error);
      // `[]` would read as "the queue is empty", which is a different and unearned answer.
      expect(noQueues).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect(noRuns).toBeUltimateError('X_NOT_IMPLEMENTED');
      expect((noQueues as { cause: string }).cause).toContain('jobs');
    } finally {
      setJobDriver(driver);
    }
  });
});

describe('tables()', () => {
  test('columns come back as a LIST of physical columns, named and typed', async () => {
    const tables = await defaultDevSources().tables();
    const table = tables.find((candidate) => candidate.name === widget.$name);
    expect(table).toBeDefined();
    if (table === undefined) return;

    // Read as a RECORD this produced a table whose columns were called "0", "1", "2".
    // The PHYSICAL column names, which is the vocabulary a psql tab speaks — `createdAt` on the
    // row is `created_at` in the table.
    expect(table.columns.map((column) => column.name)).toEqual(['id', 'label', 'created_at']);
    expect(table.columns.every((column) => column.type !== 'unknown')).toBe(true);
    // `notNull !== true` is the nullable rule: a primary key is not nullable.
    expect(table.columns.find((column) => column.name === 'id')?.nullable).toBe(false);
  });
});

describe('cacheGraph()', () => {
  test('one entity tag at a time, answered by the cache graph itself', async () => {
    const dependent = { kind: 'isr-route', id: '/widgets' } as const;
    registerDependent([{ entity: widget.$name }], dependent);
    try {
      const graph = await defaultDevSources().cacheGraph();
      const edge = graph.find((candidate) => candidate.tag === widget.$name);
      expect(edge).toBeDefined();
      if (edge === undefined) return;

      expect(edge.dependents).toEqual([{ kind: 'isr-route', id: '/widgets' }]);
    } finally {
      unregisterDependent(dependent);
    }
  });

  test('an entity nothing depends on has an edge with no dependents, not a missing row', async () => {
    const graph = await defaultDevSources().cacheGraph();
    const edge = graph.find((candidate) => candidate.tag === widget.$name);
    expect(edge?.dependents).toEqual([]);
  });
});

describe('drift()', () => {
  // Drift is the entities against the DATABASE, and `describeEntities()` is one half of that
  // comparison. This source used to read a `drift` key off `EntityDescription`, which has never
  // had one, and answered `[]` for every app — "no drift" printed over a database nobody opened.
  test('the entity registry cannot answer drift, so the source refuses instead of saying "none"', async () => {
    const refusal = await defaultDevSources()
      .drift()
      .catch((error: unknown) => error);

    expect(refusal).toBeUltimateError('X_NOT_IMPLEMENTED');
    // The fix is the hook a host holding the connection wires, named.
    expect((refusal as { fix: string }).fix).toContain('drift');

    // The premise: there ARE entities registered, so the refusal is about the QUESTION and not
    // about an empty registry. Without this the assertion above passes against nothing.
    expect((await defaultDevSources().tables()).length).toBeGreaterThan(0);
  });
});
