// `subjectErase()` over a parent that keeps `history`, on the MEMORY driver: the same erase as
// `subject-history.job.test.ts` proves on Postgres, through the entity's `purgingHistory` seam
// instead of the guard trigger's `x.purge` — so a test written against memory means the same.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { Driver } from '@ultimat3/entity';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { JobExecution } from './execute-result';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { SubjectTreatment } from './subject';
import { defineSubject, resetSubjects } from './subject';
import { subjectErase } from './subject-jobs';

const ORG = '00000000-0000-7000-8000-0000000000e1';
const ME = '00000000-0000-7000-8000-000000000201';
const YOU = '00000000-0000-7000-8000-000000000202';
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const people = entity('sjhm_people', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), email: text({ max: 80 }) },
});
const posts = entity('sjhm_posts', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid().references(() => people.id, { onDelete: 'restrict' }),
    title: text({ max: 80 }),
  },
});
const postsHistory = posts.$history ?? expect.unreachable('sjhm_posts declares history');
// Soft-deletable, so only ever anonymized: a note soft-deleted before the erase is hidden from
// every filtered write, and its images still name its author.
const notes = entity('sjhm_notes', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid()
      .nullable()
      .references(() => people.id, { onDelete: 'set null' }),
    body: text({ max: 80 }),
    deletedAt: timestamp().nullable(),
  },
});
const notesHistory = notes.$history ?? expect.unreachable('sjhm_notes declares history');

let jobs: JobDriver;
const rows: Driver = memoryDriver();
const db = () => database({ people, posts, postsHistory, notes, notesHistory }, { driver: rows });

afterAll(() => {
  resetJobs();
  resetSubjects();
  clearRegistry();
});

beforeEach(async () => {
  resetJobs();
  resetSubjects();
  jobs = memoryJobDriver();
  installJobDriver(jobs);
  rows.reset?.();
  const scope = { orgId: ORG };
  for (const [n, who] of [ME, YOU].entries()) {
    await db().people.insert({ id: who, orgId: ORG, email: `p${n}@x.test` }, scope);
  }
  for (const [n, who] of [ME, ME, YOU].entries()) {
    await db().posts.insert({ id: id(n + 1), orgId: ORG, authorId: who, title: `t${n}` }, scope);
    await db().posts.update(id(n + 1), { title: `t${n} edited` }, scope);
  }
});

afterEach(() => resetJobDriver());

type Tables = Readonly<Record<string, SubjectTreatment>>;
/** The subject deleted, its posts with it; its notes (none unless a test writes one) unlinked. */
const withPosts = (history: SubjectTreatment): Tables => ({
  sjhm_people: 'delete',
  sjhm_posts: 'delete',
  sjhm_posts_history: history,
  sjhm_notes: { anonymize: { authorId: null } },
  sjhm_notes_history: 'delete',
});

const run = async (tables: Tables): Promise<JobExecution | undefined> => {
  const handle: AnyJobHandle = subjectErase({
    name: 'members.erase',
    input: t.object({ orgId: t.string, memberId: t.string }),
    tenant: (input) => input.orgId,
    subject: defineSubject<{ readonly orgId: string; readonly memberId: string }>(people, {
      driver: rows,
      key: (input) => input.memberId,
      tables,
      batch: 1,
    }),
  });
  await jobs.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: ORG, memberId: ME },
    idempotencyKey: `${handle.name}:${ME}`,
    tenantId: ORG,
    maxAttempts: 1,
  });
  const [claimed] = await jobs.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
  return executeJob({ driver: jobs, claimed: claimed as ClaimedJob, handle, ctx });
};

const historyOf = async (table: 'sjhm_posts_history' | 'sjhm_notes_history') =>
  // A history row's tenant column is absent from its type: the read is scoped by the actor's org.
  (
    await runWithContext(ctxOf({ actor: userActor({ id: 'reader', orgId: ORG }) }), () =>
      (table === 'sjhm_posts_history' ? db().postsHistory : db().notesHistory).limit(100).all(),
    )
  )
    .map((row) => String(row.rowId))
    .sort();

describe('job · subjectErase · history · memory', () => {
  test("'delete': every image of the erased rows goes, its own delete's included", async () => {
    const done = await run(withPosts('delete'));
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjhm_posts_history')).toEqual([id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjhm_posts: { deleted: 2, anonymized: 0, retained: 0 },
        sjhm_posts_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });
  test('a row deleted before the erase still loses its images: they name the subject', async () => {
    await db().posts.delete(id(1), { orgId: ORG });
    const done = await run(withPosts('delete'));
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjhm_posts_history')).toEqual([id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjhm_posts: { deleted: 1, anonymized: 0, retained: 0 },
        // id(1)'s insert, update and delete; id(2)'s insert, update and the erase's own delete.
        sjhm_posts_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });

  test('{ retain } counts the images of a row deleted before the erase too', async () => {
    await db().posts.delete(id(1), { orgId: ORG });
    const done = await run(withPosts({ retain: 'the audit trail outlives the post' }));
    expect(done?.outcome).toBe('completed');
    expect(done?.result).toMatchObject({
      tables: { sjhm_posts_history: { deleted: 0, anonymized: 0, retained: 5 } },
    });
  });

  test('a soft-deleted row, which no filtered write reaches, still loses its images', async () => {
    const scope = { orgId: ORG };
    for (const [n, who] of [ME, ME, YOU].entries()) {
      await db().notes.insert({ id: id(n + 11), orgId: ORG, authorId: who, body: `n${n}` }, scope);
    }
    await db().notes.delete(id(11), scope);
    const done = await run({
      sjhm_people: { anonymize: { email: 'gone' } },
      sjhm_posts: { retain: 'a post outlives its author' },
      sjhm_notes: { anonymize: { body: 'gone' } },
      sjhm_notes_history: 'delete',
    });
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjhm_notes_history')).toEqual([id(13)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjhm_notes: { deleted: 0, anonymized: 1, retained: 0 },
        // id(11)'s insert and soft delete; id(12)'s insert and the erase's own anonymize.
        sjhm_notes_history: { deleted: 4, anonymized: 0, retained: 0 },
      },
    });
  });

  test("the subject's delete purges a set-null child's history in its step, as on Postgres", async () => {
    const scope = { orgId: ORG };
    for (const [n, who] of [ME, ME, YOU].entries()) {
      await db().notes.insert({ id: id(n + 11), orgId: ORG, authorId: who, body: `n${n}` }, scope);
    }
    await db().notes.delete(id(12), scope);
    const done = await run({ ...withPosts('delete'), sjhm_notes: { anonymize: { body: 'gone' } } });
    // The memory driver runs no referential action, so its set null records no image; the purge
    // the subject's step owes the child's history still runs, nested, and the history agrees.
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjhm_notes_history')).toEqual([id(13)]);
  });
});
