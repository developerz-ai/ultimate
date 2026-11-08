// A job's statements in the exercise pass are its OWN execution's: never the jobs it queues (one per
// row, counted by the scale sweep as a loop the job does not have) and never a job some earlier
// primitive left queued. A job whose own body loops per row is still red.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/action';
import { entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import type { NamedActor } from '@ultimat3/policy';
import { testActor } from '@ultimat3/policy';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { subjectsOf } from './exercise-subjects';
import { testJobs } from './fixture-jobs';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('ejs_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const notes = entity('ejs_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ entity: name, row }) => {
    if (name === orgs.$name) await driver.repo(orgs).insert(row as never);
    else await driver.repo(notes).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('ejs-worker', { permissions: [], orgId: tenant }),
];

const OrgInput = t.object({ ejsOrgId: t.uuid });
const retry = { ...DEFAULT_RETRY, attempts: 1 };

/** One read by primary key: what each queued child does, and what an earlier primitive left. */
const ejsChild = job({
  name: 'ejsChild',
  tenant: (input) => input.ejsOrgId,
  input: t.object({ ejsOrgId: t.uuid, ejsNoteId: t.uuid }),
  idempotencyKey: (input) => input.ejsNoteId,
  retry,
  run: async ({ input }) => {
    await driver.repo(notes).findById(input.ejsNoteId);
  },
});

/** One read of the list, then one child per row: flat itself, its children are theirs. */
job({
  name: 'ejsFanOut',
  tenant: (input) => input.ejsOrgId,
  input: OrgInput,
  idempotencyKey: (input) => input.ejsOrgId,
  retry,
  run: async ({ input, step }) => {
    const page = await driver.repo(notes).findMany();
    await step.run('fan-out', async () => {
      for (const row of page.rows) {
        await ejsChild.enqueue({ ejsOrgId: input.ejsOrgId, ejsNoteId: row.id });
      }
      return page.rows.length;
    });
  },
});

/** One read of the list, then each row again by id in its OWN body: a loop that is the job's. */
job({
  name: 'ejsLoop',
  tenant: (input) => input.ejsOrgId,
  input: OrgInput,
  idempotencyKey: (input) => input.ejsOrgId,
  retry,
  run: async () => {
    const page = await driver.repo(notes).findMany();
    for (const row of page.rows) await driver.repo(notes).findById(row.id);
  },
});

/** Exactly one statement of its own. */
job({
  name: 'ejsAlone',
  tenant: (input) => input.ejsOrgId,
  input: OrgInput,
  idempotencyKey: (input) => input.ejsOrgId,
  retry,
  run: async ({ input }) => {
    await driver.repo(orgs).findById(input.ejsOrgId);
  },
});

const one = async (only: string): Promise<ExerciseRecord> => {
  const records = await runExercisePass({ entities: [orgs, notes], writer, roles, only });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · a job counts its own execution'), () => {
  test('a job that queues one child per row is flat: the children are queued, never its own', async () => {
    const record = await one('ejsFanOut');
    expect(record.outcome).toBe('reached');
    expect(record.scale).toEqual({ verdict: 'flat', expected: [] });
    // Its one read of the list, and no child's findById.
    expect(record.statements).toBe(1);
    const queued = record.effects.find((one) => one.kind === 'enqueue' && one.job === 'ejsChild');
    expect(queued).toMatchObject({ kind: 'enqueue', job: 'ejsChild' });
  });

  test('a job that loops per row in its own body is still red', async () => {
    const record = await one('ejsLoop');
    expect(record.outcome).toBe('reached');
    expect(record.scale?.verdict).toBe('grows');
    const shapes = record.scale?.verdict === 'grows' ? record.scale.shapes : [];
    expect(shapes.map((shape) => shape.fingerprint)).toEqual(['ejs_notes.findById']);
  });

  test('a job run on a queue an earlier primitive left full counts none of what it found', async () => {
    const subject = (await subjectsOf()).find((one) => one.name === 'ejsAlone');
    if (subject === undefined) return expect.unreachable('ejsAlone is registered');
    const org = crypto.randomUUID();
    await using room = await openExerciseRoom();
    await using jobs = await testJobs();
    // Left by an earlier primitive: a child of somebody else's, due now.
    await jobs.enqueue(ejsChild, { ejsOrgId: org, ejsNoteId: crypto.randomUUID() });
    room.begin('ejsAlone');
    const answer = await subject.call({ ejsOrgId: org }, null, org, jobs);
    const observed = room.end();
    expect(answer.failure).toBeUndefined();
    expect(observed.shapes.map((shape) => shape.fingerprint)).toEqual(['ejs_orgs.findById']);
    expect(observed.statements).toBe(1);
    // Not drained by the subject: it is still the queue's.
    expect(await jobs.depth(ejsChild)).toBe(1);
  });
});
