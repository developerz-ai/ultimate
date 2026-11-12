// `subjectErase()` over a parent that keeps `history`, on Postgres (embedded PGlite, migrated by the
// migration `x db gen` writes), so the history guard trigger is real: an erase deletes the parent's
// history rows — those that were there AND the image its own delete just recorded — under `x.purge`
// naming that table, and anybody else's history stays.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import type { Driver } from '@ultimat3/entity';
import {
  clearRegistry,
  database,
  entity,
  postgresDriver,
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

const PGLITE_BOOT_MS = 30_000;
const ORG = '00000000-0000-7000-8000-0000000000e1';
const ME = '00000000-0000-7000-8000-000000000201';
const YOU = '00000000-0000-7000-8000-000000000202';
const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const people = entity('sjh_people', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), email: text({ max: 80 }) },
});
const posts = entity('sjh_posts', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid().references(() => people.id, { onDelete: 'restrict' }),
    title: text({ max: 80 }),
  },
});
const postsHistory = posts.$history ?? expect.unreachable('sjh_posts declares history');
// Soft-deletable, so only ever anonymized: a note soft-deleted before the erase is hidden from
// every filtered write, and its images still name its author.
const notes = entity('sjh_notes', {
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
const notesHistory = notes.$history ?? expect.unreachable('sjh_notes declares history');
// Kept, under a post the erase deletes: the post's delete (not the subject's) sets its key null.
const likes = entity('sjh_likes', {
  history: true,
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    postId: uuid()
      .nullable()
      .references(() => posts.id, { onDelete: 'set null' }),
    note: text({ max: 80 }),
  },
});
const likesHistory = likes.$history ?? expect.unreachable('sjh_likes declares history');
const ENTITIES = [people, posts, postsHistory, notes, notesHistory, likes, likesHistory];

const client = pgliteClient();
let jobs: JobDriver;
const rows: Driver = postgresDriver();
const db = () =>
  database(
    { people, posts, postsHistory, notes, notesHistory, likes, likesHistory },
    { driver: rows },
  );

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: ENTITIES.map((e) => e.$describe()),
    name: 'subject history',
    now: new Date('2026-11-12T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  resetJobs();
  resetSubjects();
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

beforeEach(async () => {
  resetJobs();
  resetSubjects();
  jobs = memoryJobDriver();
  installJobDriver(jobs);
  await client.execute(raw('delete from "sjh_likes"'));
  await client.execute(raw('delete from "sjh_posts"'));
  await client.execute(raw('delete from "sjh_notes"'));
  await client.execute(raw('delete from "sjh_people"'));
  // The guard refuses a plain delete of history: only a purge empties it between tests.
  for (const history of ['sjh_posts_history', 'sjh_notes_history', 'sjh_likes_history']) {
    await client.execute(raw(`select set_config('x.purge', '${history}', false)`));
    await client.execute(raw(`delete from "${history}"`));
  }
  await client.execute(raw(`select set_config('x.purge', '', false)`));
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
  sjh_people: 'delete',
  sjh_posts: 'delete',
  sjh_posts_history: history,
  sjh_notes: { anonymize: { authorId: null } },
  sjh_notes_history: 'delete',
  sjh_likes: { anonymize: { note: 'gone' } },
  sjh_likes_history: 'delete',
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

const historyOf = async (table = 'sjh_posts_history'): Promise<readonly string[]> =>
  (await client.query<{ row_id: string }>(raw(`select row_id from "${table}"`)))
    .map((row) => row.row_id)
    .sort();

describe('job · subjectErase · history', () => {
  test("'delete': every image of the erased rows goes, its own delete's included", async () => {
    const done = await run(withPosts('delete'));
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    // YOU's post kept its two images (insert, update); nothing of mine is left.
    expect(await historyOf()).toEqual([id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjh_posts: { deleted: 2, anonymized: 0, retained: 0 },
        // Two images per post written by the seed, and the one each post's delete recorded.
        sjh_posts_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });

  test('{ retain }: the images stay, counted, and the run still completes', async () => {
    const done = await run(withPosts({ retain: 'the audit trail outlives the post' }));
    expect(done?.outcome).toBe('completed');
    expect(await historyOf()).toEqual([id(1), id(1), id(1), id(2), id(2), id(2), id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: { sjh_posts_history: { deleted: 0, anonymized: 0, retained: 4 } },
    });
  });
  test('a row deleted before the erase still loses its images: they name the subject', async () => {
    await db().posts.delete(id(1), { orgId: ORG });
    const done = await run(withPosts('delete'));
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjh_posts_history')).toEqual([id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjh_posts: { deleted: 1, anonymized: 0, retained: 0 },
        // id(1)'s insert, update and delete; id(2)'s insert, update and the erase's own delete.
        sjh_posts_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });

  test('{ retain } counts the images of a row deleted before the erase too', async () => {
    await db().posts.delete(id(1), { orgId: ORG });
    const done = await run(withPosts({ retain: 'the audit trail outlives the post' }));
    expect(done?.outcome).toBe('completed');
    expect(done?.result).toMatchObject({
      tables: { sjh_posts_history: { deleted: 0, anonymized: 0, retained: 5 } },
    });
  });

  test('a soft-deleted row, which no filtered write reaches, still loses its images', async () => {
    const scope = { orgId: ORG };
    for (const [n, who] of [ME, ME, YOU].entries()) {
      await db().notes.insert({ id: id(n + 11), orgId: ORG, authorId: who, body: `n${n}` }, scope);
    }
    await db().notes.delete(id(11), scope);
    const done = await run({
      sjh_people: { anonymize: { email: 'gone' } },
      sjh_posts: { retain: 'a post outlives its author' },
      sjh_notes: { anonymize: { body: 'gone' } },
      sjh_notes_history: 'delete',
    });
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf('sjh_notes_history')).toEqual([id(13)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjh_notes: { deleted: 0, anonymized: 1, retained: 0 },
        // id(11)'s insert and soft delete; id(12)'s insert and the erase's own anonymize.
        sjh_notes_history: { deleted: 4, anonymized: 0, retained: 0 },
      },
    });
  });

  test("the subject's own delete, which sets a kept row's key null, leaves no image naming it", async () => {
    const scope = { orgId: ORG };
    for (const [n, who] of [ME, ME, YOU].entries()) {
      await db().notes.insert({ id: id(n + 11), orgId: ORG, authorId: who, body: `n${n}` }, scope);
    }
    // Soft-deleted: no filtered write reaches it, and the subject's delete still sets its key null.
    await db().notes.delete(id(12), scope);
    const done = await run({ ...withPosts('delete'), sjh_notes: { anonymize: { body: 'gone' } } });
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    // `on delete set null` really ran: the notes are kept, unlinked from the erased subject.
    const kept = await client.query<{ id: string; author_id: string | null }>(
      raw('select id, author_id from "sjh_notes" order by id'),
    );
    expect(kept).toEqual([
      { id: id(11), author_id: null },
      { id: id(12), author_id: null },
      { id: id(13), author_id: YOU },
    ]);
    expect(await historyOf('sjh_notes_history')).toEqual([id(13)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjh_notes: { deleted: 0, anonymized: 1, retained: 0 },
        // id(11): insert, the erase's anonymize, the set null; id(12): insert, soft delete, set null.
        sjh_notes_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });

  test("a deleted child's own delete, setting a grandchild's key null, leaves no image of it", async () => {
    const scope = { orgId: ORG };
    // Two likes on my posts, one on yours: the erase reaches mine through the posts it deletes.
    for (const [n, post] of [id(1), id(2), id(3)].entries()) {
      await db().likes.insert({ id: id(n + 21), orgId: ORG, postId: post, note: `l${n}` }, scope);
    }
    const done = await run(withPosts('delete'));
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    const kept = await client.query<{ id: string; post_id: string | null }>(
      raw('select id, post_id from "sjh_likes" order by id'),
    );
    expect(kept).toEqual([
      { id: id(21), post_id: null },
      { id: id(22), post_id: null },
      { id: id(23), post_id: id(3) },
    ]);
    expect(await historyOf('sjh_likes_history')).toEqual([id(23)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjh_likes: { deleted: 0, anonymized: 2, retained: 0 },
        // Each of mine: insert, the erase's anonymize, and the set null its post's delete made.
        sjh_likes_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });
});
