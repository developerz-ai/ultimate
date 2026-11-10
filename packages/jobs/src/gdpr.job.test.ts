// `personalData()` against the subject jobs: a declaration that covers every marked column erases
// every marked value of the person (proved by scanning each marked table after the run); one that
// misses a column, or a marked table no subject reaches, is named before any run. Memory driver.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuditRecord } from '@ultimat3/core';
import { ctxOf, userActor } from '@ultimat3/core';
import { installAuditSink } from '@ultimat3/core/adapter';
import type { Driver } from '@ultimat3/entity';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  personalDataEntities,
  text,
  uuid,
} from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { personalDataProblems } from './gdpr-coverage';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import type { SubjectTreatment } from './subject';
import { defineSubject, resetSubjects } from './subject';
import { subjectErase } from './subject-jobs';

const ORG = '00000000-0000-7000-8000-0000000000e1';
const ME = '00000000-0000-7000-8000-000000000201';
const YOU = '00000000-0000-7000-8000-000000000202';

const people = entity('gd_people', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    email: text({ max: 80 }).personalData('contact'),
    handle: text({ max: 40 }).personalData('identifier'),
    plan: text({ max: 20 }),
  },
});
const posts = entity('gd_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    authorId: uuid().references(() => people.id),
    body: text({ max: 200 }).personalData('free-text'),
  },
});
const leads = entity('gd_leads', {
  columns: { id: uuid().primaryKey(), phone: text({ max: 20 }).personalData('contact') },
});

const INPUT = t.object({ orgId: t.string, memberId: t.string });
let rows: Driver;

const subjectWith = (tables: Readonly<Record<string, SubjectTreatment>>) =>
  defineSubject<{ readonly orgId: string; readonly memberId: string }>(people, {
    driver: rows,
    key: (input) => input.memberId,
    tables,
  });

const COVERED = {
  gd_people: { anonymize: { email: 'erased@invalid', handle: 'erased' } },
  gd_posts: 'delete',
} as const;

beforeEach(async () => {
  resetJobs();
  resetSubjects();
  rows = memoryDriver();
  const db = database({ people, posts }, { driver: rows });
  const scope = { orgId: ORG };
  await db.people.insert(
    { id: ME, orgId: ORG, email: 'me@x.test', handle: 'me', plan: 'pro' },
    scope,
  );
  await db.people.insert(
    { id: YOU, orgId: ORG, email: 'you@x.test', handle: 'you', plan: 'free' },
    scope,
  );
  await db.posts.insert({ id: crypto.randomUUID(), orgId: ORG, authorId: ME, body: 'mine' }, scope);
  await db.posts.insert(
    { id: crypto.randomUUID(), orgId: ORG, authorId: YOU, body: 'yours' },
    scope,
  );
});

afterAll(() => {
  resetJobs();
  resetSubjects();
  clearRegistry();
});

const runErase = async (tables: Readonly<Record<string, SubjectTreatment>>) => {
  const handle = subjectErase({
    name: 'gd.erase',
    input: INPUT,
    tenant: (input) => input.orgId,
    subject: subjectWith(tables),
  }) as AnyJobHandle;
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: ORG, memberId: ME },
    idempotencyKey: `gd.erase:${ME}`,
    tenantId: ORG,
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

/** Every marked value still stored in every marked table the subject reached, as text. */
const markedValues = async (): Promise<readonly string[]> => {
  const db = database({ people, posts }, { driver: rows });
  const found = [
    ...(await db.people.where({ orgId: ORG }).all()),
    ...(await db.posts.where({ orgId: ORG }).all()),
  ];
  const marked = personalDataEntities().flatMap((each) => each.columns.map((c) => c.property));
  return found.flatMap((row) =>
    marked.flatMap((property) => {
      const value = (row as Readonly<Record<string, unknown>>)[property];
      return typeof value === 'string' ? [value] : [];
    }),
  );
};

const codes = (problems: readonly { code: string; meta?: unknown }[]) =>
  problems.map((problem) => [problem.code, problem.meta]);

describe('personalData() coverage of the declared subjects', () => {
  test('covered: the erase leaves no marked value of the person, and all of everyone else’s', async () => {
    subjectWith(COVERED);
    const reached = personalDataEntities().filter((each) => each.entity.$name !== 'gd_leads');
    expect(personalDataProblems(undefined, reached)).toEqual([]);
    expect((await runErase(COVERED)).outcome).toBe('completed');
    const left = await markedValues();
    for (const mine of ['me@x.test', 'me', 'mine']) expect(left).not.toContain(mine);
    for (const yours of ['you@x.test', 'you', 'yours']) expect(left).toContain(yours);
  });

  test('an anonymize missing a marked column is named, and its erase refused before any row', async () => {
    const leaky = { ...COVERED, gd_people: { anonymize: { email: 'erased@invalid' } } };
    subjectWith(leaky);
    expect(codes(personalDataProblems())).toContainEqual([
      'X_PERSONAL_DATA_UNERASED',
      { subject: 'gd_people', table: 'gd_people', columns: ['handle'] },
    ]);
    const refused = await runErase(leaky);
    expect(refused.code).toBe('X_PERSONAL_DATA_UNERASED');
    // Planned before the first step: the posts it would have deleted are still there.
    for (const kept of ['me@x.test', 'me', 'mine']) expect(await markedValues()).toContain(kept);
  });

  test('a marked entity no subject reaches is named, with the subjects that exist', () => {
    subjectWith(COVERED);
    expect(codes(personalDataProblems())).toEqual([
      [
        'X_PERSONAL_DATA_UNREACHED',
        { table: 'gd_leads', columns: ['phone'], subjects: ['gd_people'] },
      ],
    ]);
  });

  test('retain is a stated reason, not a leak', () => {
    subjectWith({ ...COVERED, gd_posts: { retain: 'kept for the moderation record' } });
    const reached = personalDataEntities().filter((each) => each.entity.$name !== 'gd_leads');
    expect(personalDataProblems(undefined, reached)).toEqual([]);
  });

  test('declares nothing about the unmarked plan column', () => {
    expect(leads.$name).toBe('gd_leads');
    expect(
      personalDataEntities()
        .find((each) => each.entity.$name === 'gd_people')
        ?.columns.map((c) => c.property),
    ).toEqual(['email', 'handle']);
  });
});

describe('subjectErase() audits the erase', () => {
  test('one allowed record per completed erase: the subject and the run — never the key', async () => {
    const records: AuditRecord[] = [];
    const release = installAuditSink({ write: (record) => void records.push(record) });
    let execution: Awaited<ReturnType<typeof runErase>> | undefined;
    try {
      execution = await runErase(COVERED);
    } finally {
      release();
    }
    expect(execution?.outcome).toBe('completed');
    const runId = String((records[0]?.input as { run?: unknown } | undefined)?.run);
    expect(records.map((r) => [r.name, r.primitive, r.surface, r.outcome, r.input])).toEqual([
      ['gd.erase', 'job', 'job', 'allowed', { subject: 'gd_people', run: runId }],
    ]);
    // The run id dedupes a replayed write: the step that writes it is at least once.
    expect(records[0]?.idempotencyKey).toBe(`gd.erase:${runId}`);
    // The key is the app's (an email, if it keys people by one): never in the sink.
    const written = JSON.stringify(records.map((r) => [r.input, r.idempotencyKey]));
    for (const value of [ME, 'me@x.test', 'me']) expect(written).not.toContain(`"${value}"`);
    expect(written).not.toContain(ME);
  });

  test('a refused erase is a failed record with its code', async () => {
    const records: AuditRecord[] = [];
    const release = installAuditSink({ write: (record) => void records.push(record) });
    try {
      await runErase({ ...COVERED, gd_people: { anonymize: { email: 'erased@invalid' } } });
    } finally {
      release();
    }
    expect(records.map((r) => [r.outcome, r.failure?.code])).toEqual([
      ['failed', 'X_PERSONAL_DATA_UNERASED'],
    ]);
  });

  test('a sink that refuses fails the run: no erase is unrecorded', async () => {
    const release = installAuditSink({
      // INPUT to the code under test: a sink whose store is down.
      write: () => Promise.reject(new TypeError('audit store down')),
    });
    try {
      expect((await runErase(COVERED)).outcome).not.toBe('completed');
    } finally {
      release();
    }
  });
});
