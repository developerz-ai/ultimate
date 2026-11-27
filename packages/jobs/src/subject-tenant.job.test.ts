// A subject that IS the tenant (`defineSubject(orgs, …)` in a multi-tenant app): its children's tenant
// column is the foreign key to the subject, and the tenant guard accepts only `eq` the actor's org on it.
// Export and erase walk those children as the org's own actor, and leave another org's rows alone.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import type { Driver } from '@ultimat3/entity';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { memoryExportSink } from './export-sink';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { defineSubject, resetSubjects } from './subject';
import { subjectErase, subjectExport } from './subject-jobs';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const MINE = id(1);
const OTHER = id(2);

const orgs = entity('st_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});
// The tenant column IS the foreign key to the subject.
const projects = entity('st_projects', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => orgs.id),
    title: text({ max: 80 }),
  },
});
// A grandchild: keyed through its parent, its tenant column stays the org.
const tasks = entity('st_tasks', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    projectId: uuid().references(() => projects.id),
    title: text({ max: 80 }),
  },
});

let driver: JobDriver;
let rows: Driver;

const subject = () =>
  defineSubject<{ readonly orgId: string }>(orgs, {
    driver: rows,
    key: (input) => input.orgId,
    tables: { st_orgs: 'delete', st_projects: 'delete', st_tasks: 'delete' },
    batch: 1,
  });

const INPUT = t.object({ orgId: t.string });

const seed = async (): Promise<void> => {
  const db = database({ orgs, projects, tasks }, { driver: rows });
  for (const [org, name] of [
    [MINE, 'mine'],
    [OTHER, 'other'],
  ] as const) {
    await db.orgs.insert({ id: org, name }, { orgId: org });
  }
  for (const [n, org] of [
    [10, MINE],
    [11, MINE],
    [12, OTHER],
  ] as const) {
    await db.projects.insert({ id: id(n), orgId: org, title: `p${n}` }, { orgId: org });
    await db.tasks.insert(
      { id: id(n + 10), orgId: org, projectId: id(n), title: `t${n}` },
      { orgId: org },
    );
  }
};

const left = async (org: string) => {
  const db = database({ orgs, projects, tasks }, { driver: rows });
  const scope = { orgId: org };
  return {
    orgs: (await db.orgs.where({ id: org }).all()).length,
    projects: (await db.projects.where({ orgId: org }).all()).map((r) => r.id),
    tasks: (await db.tasks.where({ orgId: org }).all()).map((r) => r.id),
    scope,
  };
};

const run = async (handle: AnyJobHandle) => {
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: MINE },
    idempotencyKey: `${handle.name}:${MINE}`,
    tenantId: MINE,
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
  return executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx });
};

beforeEach(async () => {
  resetJobs();
  resetSubjects();
  rows = memoryDriver();
  driver = memoryJobDriver();
  installJobDriver(driver);
  await seed();
});
afterEach(() => resetJobDriver());
afterAll(() => {
  resetJobs();
  resetSubjects();
  clearRegistry();
});

describe('job · a subject that is the tenant', () => {
  test('subjectExport walks the tenant-keyed child as the org', async () => {
    const sink = memoryExportSink();
    const done = await run(
      subjectExport({
        name: 'orgs.export',
        input: INPUT,
        tenant: (input) => input.orgId,
        subject: subject(),
        sink: () => sink,
        prefix: (input) => `subjects/${input.orgId}`,
        format: 'ndjson',
      }),
    );
    expect(done.error).toBeUndefined();
    expect(done.outcome).toBe('completed');
    const index = JSON.parse(
      new TextDecoder().decode(sink.objects().get(`subjects/${MINE}/index.json`)),
    ) as { tables: { name: string; rows: number }[] };
    expect(index.tables.map((e) => [e.name, e.rows])).toEqual([
      ['st_orgs', 1],
      ['st_projects', 2],
      ['st_tasks', 2],
    ]);
  });

  test('subjectErase deletes the org tree and leaves another org untouched', async () => {
    const done = await run(
      subjectErase({
        name: 'orgs.erase',
        input: INPUT,
        tenant: (input) => input.orgId,
        subject: subject(),
      }),
    );
    expect(done.error).toBeUndefined();
    expect(done.outcome).toBe('completed');
    expect(await left(MINE)).toMatchObject({ orgs: 0, projects: [], tasks: [] });
    expect(await left(OTHER)).toMatchObject({ orgs: 1, projects: [id(12)], tasks: [id(22)] });
  });
});
