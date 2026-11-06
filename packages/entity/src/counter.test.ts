// `references(() => posts.id, { countedIn })` answers the same in both drivers: memory moves the parent's
// integer in its repository, Postgres (embedded PGlite, migrated by the migration `x db gen` writes)
// in the child's trigger. One parity table, and the declaration refusals beside it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const posts = entity('cnt_posts', {
  columns: {
    id: uuid().primaryKey(),
    likeCount: integer().default(0),
    title: text(),
  },
});
const likes = entity('cnt_likes', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, {
      onDelete: 'cascade',
      countedIn: () => posts.likeCount,
    }),
    deletedAt: timestamp().nullable(),
  },
});

const ENTITIES = { posts, likes };
const client = pgliteClient();
const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const like = (n: number): string =>
  `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [posts.$describe(), likes.$describe()],
    name: 'counter parity',
    now: new Date('2026-11-06T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

type Db = ReturnType<typeof database<typeof ENTITIES>>;

/** The steps, each followed by both counts — the parity table's rows. */
const script = async (db: Db): Promise<readonly (readonly [string, number, number])[]> => {
  const seen: (readonly [string, number, number])[] = [];
  const read = async (step: string) => {
    const a = await db.posts.where({ id: A }).one();
    const b = await db.posts.where({ id: B }).one();
    seen.push([step, a?.likeCount ?? -1, b?.likeCount ?? -1]);
  };
  await db.posts.insert({ id: A, title: 'a' });
  await db.posts.insert({ id: B, title: 'b' });
  await db.likes.insertAll([1, 2, 3, 4].map((n) => ({ id: like(n), postId: A, deletedAt: null })));
  await read('insertAll');
  await db.likes.delete(like(1));
  await read('delete');
  await db.likes.update(like(2), { postId: B });
  await read('re-parent');
  await db.likes.update(like(3), { deletedAt: new Date('2026-11-06T00:00:00.000Z') });
  await read('soft delete');
  await db.likes.deleteWhere({ postId: B });
  await read('deleteWhere');
  await db.posts.update(A, { title: 'renamed' });
  await read('parent update');
  return seen;
};

const run = async (driver: Driver) => {
  await client.execute(raw('delete from "cnt_likes"'));
  await client.execute(raw('delete from "cnt_posts"'));
  return script(database(ENTITIES, { driver }));
};

describe('counts · both drivers, one answer', () => {
  test('memory answers as Postgres does', async () => {
    const memory = await run(memoryDriver());
    const postgres = await run(postgresDriver());
    expect(postgres).toEqual([
      ['insertAll', 4, 0],
      ['delete', 3, 0],
      ['re-parent', 2, 1],
      ['soft delete', 1, 1],
      ['deleteWhere', 1, 0],
      ['parent update', 1, 0],
    ]);
    expect(memory).toEqual(postgres);
  });
});

describe('counts · declaration', () => {
  const code = (work: () => unknown): string => {
    try {
      work();
    } catch (error) {
      return isUltimateError(error) ? error.code : 'uncoded';
    }
    return 'accepted';
  };

  test('the description carries the counter in physical names', () => {
    expect(posts.$describe().counts).toEqual([
      {
        column: 'like_count',
        key: 'id',
        table: 'cnt_likes',
        references: 'post_id',
        softDelete: 'deleted_at',
      },
    ]);
  });
  // Last: once registered, the stray key refuses every reading of the counters, as it should.
  test('a counter on a key that is no foreign key to the parent key is refused at describe', () => {
    const stray = entity('cnt_stray', {
      columns: {
        id: uuid().primaryKey(),
        title: text().references(() => posts.title, { countedIn: () => posts.likeCount }),
      },
    });
    expect(code(() => stray.$describe())).toBe('X_ENTITY_COUNTS_INVALID');
  });
});
