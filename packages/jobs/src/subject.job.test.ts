// `subjectErase()` and `subjectExport()` through the real execution path — enqueued, claimed and
// run by `executeJob` under the job's tenant. An attempt killed mid-run resumes at the step it
// stopped on and ends where an uninterrupted run ends: same rows left, same report, every part once.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import type { Driver, Repo } from '@ultimat3/entity';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { executeJob } from './execute';
import type { JobExecution } from './execute-result';
import { memoryExportSink } from './export-sink';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { SubjectTarget } from './subject';
import { defineSubject, resetSubjects } from './subject';
import { subjectErase, subjectExport } from './subject-jobs';

const ORG = '00000000-0000-7000-8000-0000000000d1';
const ME = '00000000-0000-7000-8000-000000000101';
const YOU = '00000000-0000-7000-8000-000000000102';

const people = entity('sj_people', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    email: text({ max: 80 }),
    secret: text({ max: 200 }).sealed(),
  },
});
const posts = entity('sj_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid().references(() => people.id, { onDelete: 'restrict' }),
    title: text({ max: 80 }),
  },
});
const likes = entity('sj_likes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    personId: uuid().references(() => people.id),
    postId: uuid().references(() => posts.id),
  },
});
const notes = entity('sj_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    personId: uuid().references(() => people.id),
    body: text({ max: 80 }),
  },
});

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Wraps the memory driver: `deleteWhere` on `failTable` fails once, as a dropped connection would. */
let failTable: string | undefined;
const failing = (inner: Driver): Driver => ({
  repo<Row>(core: Parameters<Driver['repo']>[0]): Repo<Row> {
    const repo = inner.repo<Row>(core as never);
    return {
      ...repo,
      deleteWhere: async (filter, options) => {
        if (failTable === core.$name) {
          failTable = undefined;
          // INPUT to the code under test: the retryable failure a lost connection raises.
          throw new DriverUnavailableError({ driver: 'db', cause: 'blip', fix: 'retry' });
        }
        return repo.deleteWhere(filter, options);
      },
    };
  },
  transactor: () => inner.transactor(),
});

let driver: JobDriver;
let rows: Driver;

const subject = () =>
  defineSubject<{ readonly orgId: string; readonly memberId: string }>(people, {
    driver: rows,
    key: (input) => input.memberId,
    tables: {
      sj_people: { anonymize: { email: 'erased@invalid' } },
      sj_posts: 'delete',
      sj_likes: 'delete',
      sj_notes: { retain: 'kept for the ledger' },
    },
    batch: 1,
  });

const INPUT = t.object({ orgId: t.string, memberId: t.string });

const seed = async (): Promise<void> => {
  const db = database({ people, posts, likes, notes }, { driver: rows });
  const scope = { orgId: ORG };
  for (const [n, who] of [ME, YOU].entries()) {
    await db.people.insert({ id: who, orgId: ORG, email: `p${n}@x.test`, secret: 's' }, scope);
  }
  for (const n of [1, 2, 3]) {
    await db.posts.insert({ id: id(n), orgId: ORG, authorId: ME, title: `mine ${n}` }, scope);
  }
  await db.posts.insert({ id: id(9), orgId: ORG, authorId: YOU, title: 'yours' }, scope);
  // YOU likes my posts (gone with them), I like yours (gone with me); YOU's like of yours stays.
  for (const [n, post] of [id(1), id(2), id(3)].entries()) {
    await db.likes.insert({ id: id(20 + n), orgId: ORG, personId: YOU, postId: post }, scope);
  }
  await db.likes.insert({ id: id(30), orgId: ORG, personId: ME, postId: id(9) }, scope);
  await db.likes.insert({ id: id(31), orgId: ORG, personId: YOU, postId: id(9) }, scope);
  await db.notes.insert({ id: id(40), orgId: ORG, personId: ME, body: 'note' }, scope);
};

const state = async () => {
  const db = database({ people, posts, likes, notes }, { driver: rows });
  const ids = async (table: { where(f: object): { all(): Promise<readonly { id: string }[]> } }) =>
    (await table.where({ orgId: ORG }).all()).map((row) => row.id).sort();
  return {
    people: (await db.people.where({ orgId: ORG }).all()).map((p) => [p.id, p.email]),
    posts: await ids(db.posts),
    likes: await ids(db.likes),
    notes: await ids(db.notes),
  };
};

const run = async (handle: AnyJobHandle): Promise<JobExecution[]> => {
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: ORG, memberId: ME },
    idempotencyKey: `${handle.name}:${ME}`,
    tenantId: ORG,
    maxAttempts: 3,
  });
  const executions: JobExecution[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [claimed] = await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    if (claimed === undefined) break;
    const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
    executions.push(await executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx }));
  }
  return executions;
};

const erase = (targets: readonly SubjectTarget[] = []) =>
  subjectErase({
    name: 'members.erase',
    input: INPUT,
    tenant: (input) => input.orgId,
    subject: defineSubject(people, { ...subject().init, targets }),
    retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: false },
  });

beforeEach(async () => {
  resetJobs();
  resetSubjects();
  rows = failing(memoryDriver());
  driver = memoryJobDriver();
  setJobDriver(driver);
  failTable = undefined;
  await seed();
});

afterEach(() => resetJobDriver());
afterAll(() => {
  resetJobs();
  resetSubjects();
  clearRegistry();
});

const AFTER = {
  people: [
    [ME, 'erased@invalid'],
    [YOU, 'p1@x.test'],
  ],
  posts: [id(9)],
  likes: [id(31)],
  notes: [id(40)],
};

describe('job · subjectErase', () => {
  test('erases what the declaration says, and nothing of anyone else', async () => {
    const [done] = await run(erase());
    expect(done?.outcome).toBe('completed');
    expect(await state()).toEqual(AFTER);
    expect(done?.result).toEqual({
      tables: {
        sj_likes: { deleted: 4, anonymized: 0, retained: 0 },
        sj_notes: { deleted: 0, anonymized: 0, retained: 1 },
        sj_people: { deleted: 0, anonymized: 1, retained: 0 },
        sj_posts: { deleted: 3, anonymized: 0, retained: 0 },
      },
    });
  });

  test('killed mid-run, the retry resumes and ends where an uninterrupted run ends', async () => {
    failTable = 'sj_posts';
    const executions = await run(erase());
    expect(executions.map((e) => e.outcome)).toEqual(['retried', 'completed']);
    expect(await state()).toEqual(AFTER);
    expect(executions[1]?.result).toEqual({
      tables: {
        sj_likes: { deleted: 4, anonymized: 0, retained: 0 },
        sj_notes: { deleted: 0, anonymized: 0, retained: 1 },
        sj_people: { deleted: 0, anonymized: 1, retained: 0 },
        sj_posts: { deleted: 3, anonymized: 0, retained: 0 },
      },
    });
  });

  test('a target is erased in batches until it answers short, before any table', async () => {
    const asked: string[] = [];
    let left = 3;
    const target: SubjectTarget = {
      name: 'x_things',
      columns: ['n'],
      exportPage: async () => ({ rows: [], cursor: null }),
      erase: async (ref, size) => {
        asked.push(String(ref.row['email']));
        const gone = Math.min(left, size);
        left -= gone;
        return gone;
      },
    };
    const [done] = await run(erase([target]));
    expect(done?.outcome).toBe('completed');
    // Read fresh each step, before the subject was anonymized; batch 1 → 3 + the short answer.
    expect(asked).toEqual(['p0@x.test', 'p0@x.test', 'p0@x.test', 'p0@x.test']);
  });
});

describe('job · subjectExport', () => {
  test('one object per page per table, sealed columns left out, an index naming each treatment', async () => {
    const sink = memoryExportSink();
    const handle = subjectExport({
      name: 'members.export',
      input: INPUT,
      tenant: (input) => input.orgId,
      subject: subject(),
      sink: () => sink,
      prefix: (input) => `subjects/${input.memberId}`,
      format: 'ndjson',
    });
    const [done] = await run(handle);
    expect(done?.error).toBeUndefined();
    expect(done?.outcome).toBe('completed');
    const text = (key: string) => new TextDecoder().decode(sink.objects().get(key));
    const me = text(`subjects/${ME}/sj_people/part-00000.ndjson`);
    expect(JSON.parse(me)).toEqual({ id: ME, orgId: ORG, email: 'p0@x.test' });
    expect(me).not.toContain('secret');
    const index = JSON.parse(text(`subjects/${ME}/index.json`)) as {
      tables: { name: string; treatment: string; rows: number; reason?: string }[];
    };
    expect(index.tables.map((e) => [e.name, e.treatment, e.rows])).toEqual([
      ['sj_people', 'anonymize', 1],
      ['sj_posts', 'delete', 3],
      ['sj_notes', 'retain', 1],
      ['sj_likes', 'delete', 4],
    ]);
    expect(index.tables[2]?.reason).toBe('kept for the ledger');
    // Every part written exactly once: batch 1, so one part per row.
    expect(sink.writes().length).toBe(1 + 1 + 3 + 4 + 1);
  });

  test('the export refuses a prefix that is not a relative key', async () => {
    const handle = subjectExport({
      name: 'members.export.bad',
      input: INPUT,
      tenant: (input) => input.orgId,
      subject: subject(),
      sink: () => memoryExportSink(),
      prefix: () => '/abs',
      format: 'csv',
    });
    const [first] = await run(handle);
    expect(first?.error).toContain('X_INVARIANT');
    expect(first?.error).toContain('not a key prefix');
  });
});

// Last: the entity it declares stays registered for the rest of the file.
describe('job · a table added later', () => {
  test('an untreated table refuses the run before a row is touched', async () => {
    entity('sj_late', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid().tenant(),
        personId: uuid().references(() => people.id),
      },
    });
    const [done] = await run(erase());
    expect(done?.outcome).toBe('dead-lettered');
    expect(done?.error).toContain('X_SUBJECT_TABLE_UNDECLARED');
    expect(await state()).not.toEqual(AFTER);
  });
});
