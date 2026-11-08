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
/** A post's events, the sort the adopter's report misnamed: its own `(org_id, seq)` declared. */
const pswEvents = entity('psw_events', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => pswOrgs.id),
    postId: uuid().references(() => pswPosts.id),
    seq: integer(),
  },
  indexes: [{ on: ['orgId', 'seq'] }],
});
/** Two keys looked up by either: an OR, which one index per arm answers. */
const keyColumns = () => ({
  id: uuid().primaryKey(),
  emailKey: text({ max: 40 }),
  phoneKey: text({ max: 40 }),
});
const pswKeys = entity('psw_keys', { columns: keyColumns() });
/** The same, each arm's index declared and migrated. */
const pswKeysIndexed = entity('psw_keys_indexed', {
  columns: keyColumns(),
  indexes: [{ on: ['emailKey'] }, { on: ['phoneKey'] }],
});
/** A person's seat in an org: the side a join keys by its own tenant column. */
const pswSeats = entity('psw_seats', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .tenant()
      .references(() => pswOrgs.id),
    userId: uuid(),
  },
  indexes: [{ on: ['orgId'] }, { on: ['userId'] }],
});
/** Badge columns: a code unique among approved badges only, the partial index the join implies. */
const badgeColumns = () => ({
  id: uuid().primaryKey(),
  userId: uuid(),
  status: text({ max: 10 }),
  code: text({ max: 20 }),
});
/** Probed per seat by `user_id`, which it indexes. */
const pswBadges = entity('psw_badges', {
  columns: badgeColumns(),
  indexes: [
    { on: ['code'], unique: true, where: (c) => c.status.eq('approved') },
    { on: ['userId'] },
  ],
});
/** The same partial index and nothing on `user_id`: no keyed path exists. */
const pswBadgesBare = entity('psw_badges_bare', {
  columns: badgeColumns(),
  indexes: [{ on: ['code'], unique: true, where: (c) => c.status.eq('approved') }],
});
const ENTITIES: readonly SeedEntity[] = [
  pswSeats,
  pswBadges,
  pswBadgesBare,
  pswOrgs,
  pswPosts,
  pswRanked,
  pswMembers,
  pswLabels,
  pswEvents,
  pswKeys,
  pswKeysIndexed,
];

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
  'create table psw_events (id uuid primary key, org_id uuid not null references psw_orgs (id), post_id uuid not null references psw_posts (id), seq integer not null)',
  'create index psw_events_org_id_idx on psw_events (org_id)',
  'create index psw_events_post_id_idx on psw_events (post_id)',
  'create index psw_events_org_id_seq_idx on psw_events (org_id, seq)',
  'create table psw_keys (id uuid primary key, email_key text not null, phone_key text not null)',
  'create table psw_keys_indexed (id uuid primary key, email_key text not null, phone_key text not null)',
  'create index psw_keys_indexed_email_key_idx on psw_keys_indexed (email_key)',
  'create index psw_keys_indexed_phone_key_idx on psw_keys_indexed (phone_key)',
  'create table psw_seats (id uuid primary key, org_id uuid not null references psw_orgs (id), user_id uuid not null)',
  'create index psw_seats_org_id_idx on psw_seats (org_id)',
  'create index psw_seats_user_id_idx on psw_seats (user_id)',
  'create table psw_badges (id uuid primary key, user_id uuid not null, status text not null, code text not null)',
  "create unique index psw_badges_code_key on psw_badges (code) where (status = 'approved')",
  'create index psw_badges_user_id_idx on psw_badges (user_id)',
  'create table psw_badges_bare (id uuid primary key, user_id uuid not null, status text not null, code text not null)',
  "create unique index psw_badges_bare_code_key on psw_badges_bare (code) where (status = 'approved')",
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

const shapes = (proof: ReturnType<Awaited<ReturnType<typeof sweepPlans>>['get']>) =>
  proof?.findings.map((one) => [one.code, one.table, one.index, one.unserved]);

/** Every printed fix changes the plan: the sort's real table, and an OR's arms. */
async function proveFixesChangeThePlan(client: DbClient): Promise<void> {
  const joined = (order: string) =>
    `select p.id, e.seq from psw_posts p join psw_events e on e.post_id = p.id and e.org_id = p.org_id where p.org_id = $1 and e.org_id = $1 order by ${order} limit $2`;
  // The adopter's shape: the sort key is an expression on the JOINED table. Never the declared
  // `(orgId, seq)` of the table the plan happens to scan first.
  const expression = joined(`date_trunc('milliseconds', p.created_at) desc, p.id desc, e.seq`);
  expect(shapes((await sweepPlans(client, sent([expression]), ENTITIES)).get('listPosts'))).toEqual(
    [['X_QUERY_SORT_UNSERVED', 'psw_posts', [], 'expression']],
  );
  const aggregate =
    'select "title", min("score") as low from "psw_posts" where "org_id" = $1 group by "title" order by 2 limit 10';
  expect(shapes((await sweepPlans(client, sent([aggregate]), ENTITIES)).get('listPosts'))).toEqual([
    ['X_QUERY_SORT_UNSERVED', 'psw_posts', [], 'aggregate'],
  ]);

  // Plain columns of one table: that table's index, and once it exists the sort is gone.
  const plain = joined('p.created_at desc, p.id desc');
  expect(shapes((await sweepPlans(client, sent([plain]), ENTITIES)).get('listPosts'))).toEqual([
    ['X_QUERY_SORT_UNSERVED', 'psw_posts', ['orgId', 'createdAt', 'id'], undefined],
  ]);
  await client.execute(
    raw('create index psw_posts_feed_idx on psw_posts (org_id, created_at, id)'),
  );
  expect((await sweepPlans(client, sent([plain]), ENTITIES)).get('listPosts')?.findings).toEqual(
    [],
  );

  // An OR: one index per arm, never `[emailKey, phoneKey]`; with both, the BitmapOr serves it.
  const either = (table: string, tail = '') =>
    `select "id" from "${table}" where "email_key" = $1 or "phone_key" = $2${tail}`;
  expect(
    shapes((await sweepPlans(client, sent([either('psw_keys')]), ENTITIES)).get('listPosts')),
  ).toEqual([
    ['X_QUERY_UNINDEXED', 'psw_keys', ['emailKey'], undefined],
    ['X_QUERY_UNINDEXED', 'psw_keys', ['phoneKey'], undefined],
  ]);
  await client.execute(raw('create index psw_keys_email_idx on psw_keys (email_key)'));
  await client.execute(raw('create index psw_keys_phone_idx on psw_keys (phone_key)'));
  const after = await sweepPlans(client, sent([either('psw_keys')]), ENTITIES);
  expect(after.get('listPosts')?.findings).toEqual([]);
  // Under a limit the sweep's settings still pick the Seq Scan: arms the entity declares an index
  // for are credited by the declaration, as a partial or a range index is.
  const limited = sent([either('psw_keys_indexed', ' limit 1')]);
  expect((await sweepPlans(client, limited, ENTITIES)).get('listPosts')?.findings).toEqual([]);
}

/**
 * A partial index whose predicate the statement implies looks like one row on an empty table, so
 * the planner walks all of it beside a join rather than probe per row. The probe exists — the join
 * key leads a declared index on the side a keyed scan drives — so it is credited; with no index
 * on the join key it is red and names it.
 */
async function proveImpliedPartial(client: DbClient): Promise<void> {
  const approved = (table: string) =>
    `select s.id from psw_seats s join ${table} b on b.user_id = s.user_id where s.org_id = $1 and b.status = 'approved'`;
  const probed = (await sweepPlans(client, sent([approved('psw_badges')]), ENTITIES)).get(
    'listPosts',
  );
  expect(probed).toMatchObject({ planned: 1, findings: [], unplannable: [] });
  const bare = await sweepPlans(client, sent([approved('psw_badges_bare')]), ENTITIES);
  expect(shapes(bare.get('listPosts'))).toEqual([
    ['X_QUERY_UNINDEXED', 'psw_badges_bare', ['userId'], undefined],
  ]);
}

afterAll(() => clearRegistry());

describe('live · plan sweep on PGlite', () => {
  test('red on an empty table, green once the index exists', async () => {
    const client = pgliteClient();
    try {
      await proveOn(client);
      await proveAdvice(client);
      await proveFixesChangeThePlan(client);
      await proveImpliedPartial(client);
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
      await proveFixesChangeThePlan(client);
      await proveImpliedPartial(client);
    } finally {
      await client.close();
      await admin.execute(raw(`drop database if exists "${database}" with (force)`));
      await admin.close();
    }
  }, 60_000);
});
