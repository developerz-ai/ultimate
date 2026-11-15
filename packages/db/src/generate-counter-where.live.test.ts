// `countedIn: { where }` on a real Postgres: the trigger counts a child only while the predicate
// holds over it — insert, flip in and out, NULL, re-parent, delete — the migration's first recount
// honours the same predicate, and the key-range recount repairs drift window by window.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import {
  recountBatchSql,
  recountDriftBatchSql,
  recountLockSql,
  recountWindowSql,
} from './generate-counter';
import { raw, sql } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const POSTS = 'cntw_posts';
const LIKES = 'cntw_likes';
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
const [A = '', B = ''] = ids;

const col = (column: string, kind: string, notNull = true, extra = {}): ColumnDescriptionLike => ({
  property: column,
  column,
  kind,
  notNull,
  primaryKey: column === 'id',
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...extra,
});

const counter = {
  column: 'up_count',
  key: 'id',
  table: LIKES,
  references: 'post_id',
  softDelete: null,
  where: { sql: `c."kind" = 'up'`, columns: ['kind'] },
};

const entities = (): readonly EntityDescriptionLike[] => [
  {
    name: POSTS,
    table: POSTS,
    primaryKey: ['id'],
    columns: [
      col('id', 'uuid'),
      col('up_count', 'integer', true, { hasDefault: true, default: { kind: 'value', value: 0 } }),
    ],
    indexes: [],
    counts: [counter],
  },
  {
    name: LIKES,
    table: LIKES,
    primaryKey: ['id'],
    columns: [
      col('id', 'uuid'),
      col('post_id', 'uuid', true, { references: `${POSTS}.id`, onDelete: 'cascade' }),
      col('kind', 'text', false),
    ],
    indexes: [],
  },
];

describe.skipIf(!hasPostgres)('live · postgres · a counter with a where', () => {
  let client: PostgresClient;
  const counts = async (): Promise<number[]> =>
    (
      await client.query<{ up_count: number }>(
        sql`select up_count from ${raw(`"${POSTS}"`)} order by id`,
      )
    ).map((row) => row.up_count);
  const like = (post: string, kind: string | null) =>
    client.execute(
      sql`insert into ${raw(`"${LIKES}"`)} (id, post_id, kind) values (gen_random_uuid(), ${post}, ${kind})`,
    );

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', profile: { max: 4 } });
    for (const table of [LIKES, POSTS]) {
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    }
    const up = generateMigration({ entities: entities(), name: 'where', now: new Date(0) }).up;
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
    for (const id of ids)
      await client.execute(sql`insert into ${raw(`"${POSTS}"`)} (id) values (${id})`);
  });

  afterAll(async () => {
    for (const table of [LIKES, POSTS]) {
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    }
    await client.close();
  });

  test('only a row the predicate holds over is counted; NULL is not', async () => {
    await like(A, 'up');
    await like(A, 'up');
    await like(A, 'down');
    await like(A, null);
    expect(await counts()).toEqual([2, 0]);
  });

  test('flipping a predicate column moves the count both ways', async () => {
    const likes = raw(`"${LIKES}"`);
    await client.execute(sql`update ${likes} set kind = 'up' where kind = 'down'`);
    expect(await counts()).toEqual([3, 0]);
    await client.execute(
      sql`update ${likes} set kind = null where id = (select id from ${likes} where kind = 'up' limit 1)`,
    );
    expect(await counts()).toEqual([2, 0]);
    await client.execute(sql`update ${likes} set post_id = ${B} where kind is null`);
    expect(await counts()).toEqual([2, 0]);
    await client.execute(sql`update ${likes} set kind = 'up', post_id = ${B} where kind is null`);
    expect(await counts()).toEqual([2, 2]);
    await client.execute(sql`delete from ${likes} where post_id = ${A}`);
    expect(await counts()).toEqual([0, 2]);
  });

  test('the key-range recount repairs every window and leaves a true counter alone', async () => {
    const posts = raw(`"${POSTS}"`);
    await client.execute(sql`update ${posts} set up_count = 9`);
    const drifted: string[] = [];
    let after: string | null = null;
    for (;;) {
      const windows: readonly { last: string | null }[] = await client.query<{
        last: string | null;
      }>(recountWindowSql(POSTS, counter, after, 1));
      const last: string | null = windows[0]?.last ?? null;
      if (last === null) break;
      await client.query(recountLockSql(POSTS, counter, after, last));
      const rows = await client.query<{ key: string }>(
        recountDriftBatchSql(POSTS, counter, after, last),
      );
      drifted.push(...rows.map((row) => row.key));
      await client.execute(recountBatchSql(POSTS, counter, after, last));
      after = last;
    }
    expect(drifted).toEqual([A, B]);
    expect(await counts()).toEqual([0, 2]);
  });
});
