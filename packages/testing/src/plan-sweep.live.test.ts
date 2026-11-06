// The plan sweep on both shipped engines, on EMPTY tables: an unindexed filter is red and names its
// index, the same statement is green once that index exists, a sort under a limit is red, and a
// statement under `expectedSeqScan` is listed exempt with its reason. PGlite always; Postgres when
// `TEST_DATABASE_URL` is set, on a scratch database of its own.

import { afterAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient, postgresClient, raw } from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import type { SentStatement } from './plan-sweep';
import { sweepPlans } from './plan-sweep';
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
    createdAt: timestamp(),
  },
});
const ENTITIES: readonly SeedEntity[] = [pswOrgs, pswPosts];

const DDL = [
  'create table psw_orgs (id uuid primary key)',
  'create table psw_posts (id uuid primary key, org_id uuid not null references psw_orgs (id), title text not null, created_at timestamptz not null)',
  'create index psw_posts_org_id_idx on psw_posts (org_id)',
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

afterAll(() => clearRegistry());

describe('live · plan sweep on PGlite', () => {
  test('red on an empty table, green once the index exists', async () => {
    const client = pgliteClient();
    try {
      await proveOn(client);
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
    } finally {
      await client.close();
      await admin.execute(raw(`drop database if exists "${database}" with (force)`));
      await admin.close();
    }
  }, 60_000);
});
