// `subjectErase()` over a parent that keeps `history`, on the MEMORY driver: the same erase as
// `subject-history.job.test.ts` proves on Postgres, through the entity's `purgingHistory` seam
// instead of the guard trigger's `x.purge` — so a test written against memory means the same.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { Driver } from '@ultimat3/entity';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
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

let jobs: JobDriver;
const rows: Driver = memoryDriver();
const db = () => database({ people, posts, postsHistory }, { driver: rows });

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

const run = async (history: SubjectTreatment): Promise<JobExecution | undefined> => {
  const handle: AnyJobHandle = subjectErase({
    name: 'members.erase',
    input: t.object({ orgId: t.string, memberId: t.string }),
    tenant: (input) => input.orgId,
    subject: defineSubject<{ readonly orgId: string; readonly memberId: string }>(people, {
      driver: rows,
      key: (input) => input.memberId,
      tables: { sjhm_people: 'delete', sjhm_posts: 'delete', sjhm_posts_history: history },
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
  // A history row's tenant column is absent from its type: the read is scoped by the actor's org.
  (
    await runWithContext(ctxOf({ actor: userActor({ id: 'reader', orgId: ORG }) }), () =>
      db().postsHistory.limit(100).all(),
    )
  )
    .map((row) => String(row.rowId))
    .sort();

describe('job · subjectErase · history · memory', () => {
  test("'delete': every image of the erased rows goes, its own delete's included", async () => {
    const done = await run('delete');
    expect([done?.outcome, done?.error]).toEqual(['completed', undefined]);
    expect(await historyOf()).toEqual([id(3), id(3)]);
    expect(done?.result).toMatchObject({
      tables: {
        sjhm_posts: { deleted: 2, anonymized: 0, retained: 0 },
        sjhm_posts_history: { deleted: 6, anonymized: 0, retained: 0 },
      },
    });
  });
});
