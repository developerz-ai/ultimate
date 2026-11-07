// The plan sweep on both shipped engines, on EMPTY tables: an unindexed filter is red and names its
// index, the same statement is green once that index exists, a sort under a limit is red, and a
// statement under `expectedSeqScan` is listed exempt with its reason. PGlite always; Postgres when
// `TEST_DATABASE_URL` is set, on a scratch database of its own.

import { afterAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient, postgresClient, raw, recordingClient } from '@ultimat3/db';
import {
  clearRegistry,
  entity,
  integer,
  invariant,
  postgresRepo,
  tableFor,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { ExerciseRecord } from './exercise-report';
import type { SentStatement } from './plan-sweep';
import { sweepPlans } from './plan-sweep';
import { planSweepFindings } from './plan-sweep-report';
import type { SeedEntity } from './seed-graph-shape';
import { urlFor } from './template-db';

const pswOrgs = entity('psw_orgs', { columns: { id: uuid().primaryKey() } });
const pswPosts = entity('psw_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => pswOrgs.id),
    title: text({ max: 80 }),
    score: integer(),
    createdAt: timestamp(),
  },
});
/** The index a range read wants, declared and migrated. */
const pswRanked = entity('psw_ranked', {
  columns: { id: uuid().primaryKey(), score: integer(), archivedAt: timestamp().nullable() },
  indexes: [{ on: ['score'] }],
});
/** Soft delete: its unique rule is partial, `where deleted_at is null`. */
const pswMembers = entity('psw_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => pswOrgs.id),
    handle: text({ max: 40 }),
    deletedAt: timestamp().nullable(),
  },
  invariants: (c) => [invariant('psw_handle_unique', c.unique(['orgId', 'handle']))],
});
/** A label is unique per org where it belongs to no project: a partial UNIQUE index. */
const pswLabels = entity('psw_labels', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => pswOrgs.id),
    name: text({ max: 40 }),
    projectId: uuid().nullable(),
    createdAt: timestamp(),
  },
  indexes: [{ on: ['orgId', 'name'], unique: true, where: (c) => c.projectId.isNull() }],
});
const ENTITIES: readonly SeedEntity[] = [pswOrgs, pswPosts, pswRanked, pswMembers, pswLabels];

const DDL = [
  'create table psw_orgs (id uuid primary key)',
  'create table psw_posts (id uuid primary key, org_id uuid not null references psw_orgs (id), title text not null, score integer not null, created_at timestamptz not null)',
  'create index psw_posts_org_id_idx on psw_posts (org_id)',
  'create table psw_ranked (id uuid primary key, score integer not null, archived_at timestamptz)',
  'create index psw_ranked_score_idx on psw_ranked (score)',
  'create table psw_members (id uuid primary key, org_id uuid not null references psw_orgs (id), handle text not null, deleted_at timestamptz)',
  'create unique index psw_members_handle_key on psw_members (org_id, handle) where (deleted_at is null)',
  'create table psw_labels (id uuid primary key, org_id uuid not null references psw_orgs (id), name text not null, project_id uuid, created_at timestamptz not null)',
  'create unique index psw_labels_name_key on psw_labels (org_id, name) where (project_id is null)',
];
const BY_TITLE = 'select "id" from "psw_posts" where "title" = $1';
const NEWEST = 'select "id" from "psw_posts" where "org_id" = $1 order by "title" limit 20';
const BY_ID = 'select "id", "title" from "psw_posts" where "id" = $1';

const sent = (...statements: [string, string?][]): ReadonlyMap<string, SentStatement> =>
  new Map(
    statements.map(([text, scan]) => [
      text,
      { primitives: new Set(['listPosts']), ...(scan === undefined ? {} : { scan }) },
    ]),
  );

async function proveOn(client: DbClient): Promise<void> {
  for (const statement of DDL) await client.execute(raw(statement));
  const before = (await sweepPlans(client, sent([BY_TITLE], [NEWEST], [BY_ID]), ENTITIES)).get(
    'listPosts',
  );
  expect(before?.planned).toBe(3);
  expect(before?.findings.map((one) => [one.code, one.index])).toEqual([
    ['X_QUERY_UNINDEXED', ['title']],
    ['X_QUERY_SORT_UNSERVED', ['orgId', 'title']],
  ]);

  await client.execute(raw('create index psw_posts_org_title_idx on psw_posts (org_id, title)'));
  const after = (await sweepPlans(client, sent([BY_TITLE], [NEWEST], [BY_ID]), ENTITIES)).get(
    'listPosts',
  );
  expect(after?.findings).toEqual([]);

  const exempt = (
    await sweepPlans(
      client,
      sent(['select "id" from "psw_posts"', 'the export reads every row']),
      ENTITIES,
    )
  ).get('listPosts');
  expect(exempt).toMatchObject({
    findings: [],
    exempt: [{ statement: 'select "id" from "psw_posts"', reason: 'the export reads every row' }],
  });
  // No prepared statement left behind: a second sweep on the same connection prepares again.
  expect((await sweepPlans(client, sent([BY_ID]), ENTITIES)).get('listPosts')).toMatchObject({
    planned: 1,
    findings: [],
    unplannable: [],
  });
}

/** The statement the framework's own `one()` sends, read off a recording client. */
async function oneStatement(): Promise<string> {
  const recorder = recordingClient();
  const members = tableFor(pswMembers, postgresRepo(pswMembers, { client: recorder }));
  await members.where({ orgId: crypto.randomUUID(), handle: 'ada' }).one();
  const [text] = recorder.texts;
  if (text === undefined) expect.unreachable('one() sent no statement');
  return text;
}

const asRecord = (name: string, plans: ExerciseRecord['plans']): ExerciseRecord => ({
  kind: 'query',
  name,
  outcome: 'reached',
  statements: 1,
  effects: [],
  ms: 1,
  ...(plans === undefined ? {} : { plans }),
});

/** The three shapes whose advice misfired, each on the engine's own plan. */
async function proveAdvice(client: DbClient): Promise<void> {
  // A whole-table aggregate: red, and the fix is a stated scan, never `on: []`.
  const count = 'select count(*) as count from "psw_posts"';
  const whole = (await sweepPlans(client, sent([count]), ENTITIES)).get('listPosts');
  expect(whole?.findings.map((one) => [one.code, one.index])).toEqual([['X_QUERY_UNINDEXED', []]]);
  const [advice] = planSweepFindings([asRecord('listPosts', whole)]);
  expect(advice?.fix).toContain('expectedSeqScan(');
  expect(advice?.fix).not.toContain('on: []');

  // A range under an order the primary key serves: the range column, never a key-led index.
  const ranged = (table: string) =>
    `select "id" from "${table}" where "score" < $1 order by "id" limit 20`;
  const range = (await sweepPlans(client, sent([ranged('psw_posts')]), ENTITIES)).get('listPosts');
  expect(range?.findings.map((one) => [one.node, one.index])).toEqual([['Index Scan', ['score']]]);
  // With that index declared and migrated the generic plan still walks the key: credited.
  const served = await sweepPlans(client, sent([ranged('psw_ranked')]), ENTITIES);
  expect(served.get('listPosts')?.findings).toEqual([]);

  // `one()` on a soft-deleted entity, its key a partial unique: one row, no finding.
  const one = await oneStatement();
  expect(one).toContain('order by "id"');
  const pinned = (await sweepPlans(client, sent([one]), ENTITIES)).get('listPosts');
  expect(pinned).toMatchObject({ planned: 1, findings: [], unplannable: [] });

  // A lookup by a partial UNIQUE index's key, its predicate `project_id is null` stated: walked
  // in key order, or sorted under a limit, it reads one row either way.
  const label =
    'select "id" from "psw_labels" where "org_id" = $1 and "name" = $2 and "project_id" is null';
  const labels = await sweepPlans(
    client,
    sent(
      [`${label} order by "id" asc nulls last limit $3`],
      [`${label} order by "created_at" limit 20`],
    ),
    ENTITIES,
  );
  expect(labels.get('listPosts')).toMatchObject({ planned: 2, findings: [], unplannable: [] });

  // `is null` pins a value as `=` does: the index takes it first, and the order after it.
  const live = 'select "id" from "psw_ranked" where "archived_at" is null order by "id" limit 20';
  const listed = (await sweepPlans(client, sent([live]), ENTITIES)).get('listPosts');
  expect(listed?.findings.map((one) => one.index)).toEqual([['archivedAt', 'id']]);
}

afterAll(() => clearRegistry());

describe('live · plan sweep on PGlite', () => {
  test('red on an empty table, green once the index exists', async () => {
    const client = pgliteClient();
    try {
      await proveOn(client);
      await proveAdvice(client);
    } finally {
      await client.close();
    }
  }, 60_000);
});

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')('live · plan sweep on Postgres', () => {
  test('red on an empty table, green once the index exists', async () => {
    const admin = postgresClient({ url: adminUrl });
    const database = probeDatabaseName('plan_sweep');
    await admin.execute(raw(`create database "${database}"`));
    const client = postgresClient({ url: urlFor(adminUrl, database) });
    try {
      await proveOn(client);
      await proveAdvice(client);
    } finally {
      await client.close();
      await admin.execute(raw(`drop database if exists "${database}" with (force)`));
      await admin.close();
    }
  }, 60_000);
});
