// The grouped count against a real Postgres. `count-by-statements.test.ts` asserts the text a
// `countBy` compiles to; nothing there proves the server accepts `select … as group_value,
// count(*) as group_count … group by … limit $n`, that the numbers are right over real rows, or
// that an int8 count arrives as a `number`. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  setStatementObserver,
} from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

// `TEST_DATABASE_URL` only: `beforeAll`/`afterAll` run `drop table … cascade`, so falling back to
// the app's own `DATABASE_URL` would hand this file whatever database a developer had exported.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_count_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/**
 * One row per reaction — the table a per-post `count()` loop is the N+1 over. `postId` is nullable
 * on purpose: SQL files every NULL row under one group, and that group has to survive the trip
 * back as the map key `null`, which is the one group value no column ever parses.
 */
const likes = entity('pg_count_live_likes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    postId: uuid().nullable(),
    reaction: text({ max: 20 }),
    score: integer(),
    deletedAt: timestamp().nullable(),
  },
});

const DROP = 'drop table if exists "pg_count_live_likes", "pg_count_live_orgs" cascade';

const POST_A = '00000000-0000-7000-8000-0000000000aa';
const POST_B = '00000000-0000-7000-8000-0000000000bb';

/** One `up` script out, one statement per `execute` in: every value in it is an identifier. */
const statementsOf = (script: string): readonly string[] =>
  script
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

describe.skipIf(!hasPostgres)('live · postgres · grouped counts', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      // Declaration order is dependency order: the foreign key needs its target first.
      entities: [orgs.$describe(), likes.$describe()],
      name: 'live grouped counts',
      now: new Date('2026-08-13T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  const db = () => database({ orgs, likes }, { driver: postgresDriver() });
  const repo = () => postgresRepo(likes);

  /** What a call produced, and every statement it sent that matched — the N+1 claim needs both. */
  const counting = async <T>(match: string, work: () => Promise<T>): Promise<[T, string[]]> => {
    const seen: string[] = [];
    setStatementObserver({
      onStatement: (event) => {
        if (event.text.includes(match)) seen.push(event.text);
      },
    });
    try {
      return [await work(), seen];
    } finally {
      setStatementObserver(undefined);
    }
  };

  const newOrg = async (slug: string): Promise<string> =>
    (await database({ orgs }, { driver: postgresDriver() }).orgs.insert({ slug })).id;

  /**
   * A tenant nobody else writes to, so every count below is an assertion and not a race: three
   * rows on post A, two on post B, one on no post at all.
   */
  const seed = async (slug: string): Promise<string> => {
    const org = await newOrg(slug);
    await db().likes.insertAll([
      { orgId: org, postId: POST_A, reaction: 'like', score: 1 },
      { orgId: org, postId: POST_A, reaction: 'like', score: 2 },
      { orgId: org, postId: POST_A, reaction: 'wow', score: 2 },
      { orgId: org, postId: POST_B, reaction: 'like', score: 1 },
      { orgId: org, postId: POST_B, reaction: 'wow', score: 3 },
      { orgId: org, postId: null, reaction: 'like', score: 1 },
    ]);
    return org;
  };

  test('the server accepts the aliased group statement and answers what count() answers', async () => {
    const org = await seed('counts');

    const [counts, sent] = await counting(' group by ', () =>
      db().likes.where({ orgId: org }).countBy('postId'),
    );

    // It ran, which is the half no recording client can assert: `as group_value` and
    // `count(*) as group_count` are names Postgres either accepts or answers 42601 for.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('as group_value');
    expect(sent[0]).toContain('count(*) as group_count');
    expect([...counts]).toEqual([
      [POST_A, 3],
      [POST_B, 2],
      [null, 1],
    ]);
    // And it agrees with the per-value `count()` loop it stands in for, on the same server.
    for (const postId of [POST_A, POST_B]) {
      const alone = await repo().count({
        orgId: org,
        where: [{ column: 'postId', op: 'eq', value: postId }],
      });
      expect(counts.get(postId)).toBe(alone);
    }
  });

  test('int8 comes back as a number, not the string Bun.SQL hands over', async () => {
    const org = await seed('int8');

    const counts = await db().likes.where({ orgId: org }).countBy('postId');

    expect(counts.size).toBe(3);
    expect([...counts.values()].every((value) => typeof value === 'number')).toBe(true);
    // The mistake the decode prevents, spelled as the arithmetic a caller writes: '3' + 1 is '31'.
    expect((counts.get(POST_A) ?? 0) + 1).toBe(4);
  });

  test('a soft-deleted row is not counted, and includeDeleted brings it back', async () => {
    const org = await seed('soft');
    // Exactly one row: post A with score 1. Stamped, not removed — the row is still on the table.
    expect(await repo().deleteWhere({ orgId: org, postId: POST_A, score: 1 })).toBe(1);

    // The `deleted_at is null` clause is what does this, on the server, over a row still there.
    expect((await db().likes.where({ orgId: org }).countBy('postId')).get(POST_A)).toBe(2);
    expect((await repo().countBy('postId', { orgId: org, includeDeleted: true })).get(POST_A)).toBe(
      3,
    );
  });

  test('another tenant is a different breakdown, never a shared one', async () => {
    const org = await seed('scoped-ours');
    const other = await newOrg('scoped-theirs');
    // The same post under the other tenant, so an unscoped statement reads 4 for both of them.
    await db().likes.insert({ orgId: other, postId: POST_A, reaction: 'like', score: 9 });

    const ours = await db().likes.where({ orgId: org }).countBy('postId');
    const theirs = await db().likes.where({ orgId: other }).countBy('postId');

    expect(ours.get(POST_A)).toBe(3);
    expect([...theirs]).toEqual([[POST_A, 1]]);
  });

  test('a text key and an integer key come back as the values they were stored as', async () => {
    const org = await seed('kinds');

    expect([...(await db().likes.where({ orgId: org }).countBy('reaction'))]).toEqual([
      ['like', 4],
      ['wow', 2],
    ]);
    // int4 out of the server is a number here: the map is keyed by 1, never by '1'.
    expect([...(await db().likes.where({ orgId: org }).countBy('score'))]).toEqual([
      [1, 3],
      [2, 2],
      [3, 1],
    ]);
  });

  test('a bounded breakdown is one statement where the loop it replaces is one per value', async () => {
    const org = await seed('bounded');

    const [counts, sent] = await counting('from "pg_count_live_likes"', () =>
      db().likes.where({ orgId: org }).andWhere('postId', 'in', [POST_A, POST_B]).countBy('postId'),
    );

    // The shape the too-many-groups refusal tells an author to write, and the whole point of the
    // call: one statement for a breakdown a `count()` per post would have paid two for.
    expect(sent).toHaveLength(1);
    expect([...counts]).toEqual([
      [POST_A, 3],
      [POST_B, 2],
    ]);
  });
});
