// `subjectErase()` over a parent that keeps `history`, on Postgres (embedded PGlite, migrated by the
// migration `x db gen` writes), so the history guard trigger is real: an erase deletes the parent's
// history rows — those that were there AND the image its own delete just recorded — under `x.purge`
// naming that table, and anybody else's history stays.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import type { Driver } from '@ultimat3/entity';
import { clearRegistry, database, entity, postgresDriver, text, uuid } from '@ultimat3/entity';
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

const client = pgliteClient();
let jobs: JobDriver;
const rows: Driver = postgresDriver();
const db = () => database({ people, posts, postsHistory }, { driver: rows });

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [people.$describe(), posts.$describe(), postsHistory.$describe()],
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
  await client.execute(raw('delete from "sjh_posts"'));
  await client.execute(raw('delete from "sjh_people"'));
  // The guard refuses a plain delete of history: only a purge empties it between tests.
  await client.execute(raw(`select set_config('x.purge', 'sjh_posts_history', false)`));
  await client.execute(raw('delete from "sjh_posts_history"'));
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

const run = async (history: SubjectTreatment): Promise<JobExecution | undefined> => {
  const handle: AnyJobHandle = subjectErase({
    name: 'members.erase',
    input: t.object({ orgId: t.string, memberId: t.string }),
    tenant: (input) => input.orgId,
    subject: defineSubject<{ readonly orgId: string; readonly memberId: string }>(people, {
      driver: rows,
      key: (input) => input.memberId,
      tables: { sjh_people: 'delete', sjh_posts: 'delete', sjh_posts_history: history },
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

const historyOf = async (): Promise<readonly string[]> =>
  (await client.query<{ row_id: string }>(raw('select row_id from "sjh_posts_history"')))
    .map((row) => row.row_id)
    .sort();

describe('job · subjectErase · history', () => {
  test("'delete': every image of the erased rows goes, its own delete's included", async () => {
    const done = await run('delete');
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
    const done = await run({ retain: 'the audit trail outlives the post' });
    expect(done?.outcome).toBe('completed');
    expect(await historyOf()).toEqual([id(1), id(1), id(1), id(2), id(2), id(2), id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: { sjh_posts_history: { deleted: 0, anonymized: 0, retained: 4 } },
    });
  });
});
