// A `countedIn` trigger rewrites the parent row in the child's own transaction; the observer reports
// that rewrite as `entity.row` for the parent, so a live query over the parent hears a like. Memory
// and Postgres (embedded PGlite, migrated by the migration `x db gen` writes) report the same events.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryTransactor } from './memory-repo';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const posts = entity('cobs_posts', {
  columns: { id: uuid().primaryKey(), likeCount: integer().default(0), title: text() },
});
const likes = entity('cobs_likes', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, {
      onDelete: 'cascade',
      countedIn: () => posts.likeCount,
    }),
    note: text().default(''),
    deletedAt: timestamp().nullable(),
  },
});

/** Tenanted: a write outside any request names its tenant on its rows, and the parent read uses it. */
const notes = entity('cobs_notes', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), stars: integer().default(0) },
});
const stars = entity('cobs_stars', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    noteId: uuid().references(() => notes.id, { countedIn: () => notes.stars }),
  },
});

const ENTITIES = { posts, likes };
const client = pgliteClient();
const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const like = (n: number): string =>
  `00000000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
const AT = new Date('2026-11-11T00:00:00.000Z');

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [posts.$describe(), likes.$describe()],
    name: 'counter observed',
    now: AT,
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

afterEach(() => resetInstrumentation());

type Db = ReturnType<typeof database<typeof ENTITIES>>;
type Heard = readonly unknown[];

const count = (row: Readonly<Record<string, unknown>> | null): number | null =>
  row === null ? null : Number(row['likeCount']);

/** Every change the parent is reported to make, per step: the table both drivers must agree on. */
const script = async (db: Db): Promise<readonly (readonly [string, readonly Heard[]])[]> => {
  await db.posts.insert({ id: A, title: 'a' });
  await db.posts.insert({ id: B, title: 'b' });
  let heard: Heard[] = [];
  subscribe('entity.row', ({ payload }) => {
    if (payload.entity !== posts.$name) return;
    const id = String((payload.after ?? payload.before)?.['id']);
    heard.push([payload.op, id === A ? 'A' : 'B', count(payload.before), count(payload.after)]);
  });
  subscribe('entity.bulk', ({ payload }) => {
    if (payload.entity === posts.$name) heard.push(['bulk', payload.op, payload.rows]);
  });
  const steps: (readonly [string, readonly Heard[]])[] = [];
  const step = async (name: string, write: () => Promise<unknown>) => {
    heard = [];
    await write();
    steps.push([name, heard]);
  };
  await step('insert', () => db.likes.insert({ id: like(1), postId: A, deletedAt: null }));
  await step('insertAll', () =>
    db.likes.insertAll([
      { id: like(2), postId: A, deletedAt: null },
      { id: like(3), postId: A, deletedAt: null },
      { id: like(4), postId: B, deletedAt: null },
    ]),
  );
  await step('re-parent', () => db.likes.update(like(2), { postId: B }));
  await step('soft delete', () => db.likes.update(like(3), { deletedAt: AT }));
  await step('delete', () => db.likes.delete(like(1)));
  await step('no key touched', () => db.likes.update(like(4), { note: 'x' }));
  await step('deleteWhere, key pinned', () => db.likes.deleteWhere({ postId: B }));
  await step('insert again', () => db.likes.insert({ id: like(5), postId: A, deletedAt: null }));
  await step('updateWhere, key unpinned', () =>
    db.likes.updateWhere({ id: like(5) }, { postId: B }),
  );
  await step('updateWhere, nothing counted', () =>
    db.likes.updateWhere({ postId: B }, { note: 'y' }),
  );
  return steps;
};

const empty = async (): Promise<void> => {
  await client.execute(raw('delete from "cobs_likes"'));
  await client.execute(raw('delete from "cobs_posts"'));
};

const run = async (driver: Driver) => {
  await empty();
  resetInstrumentation();
  return script(database(ENTITIES, { driver }));
};

describe('countedIn · the parent rewrite is a reported change', () => {
  test('memory and Postgres report the same parent changes', async () => {
    const postgres = await run(postgresDriver());
    const memory = await run(memoryDriver());
    expect(postgres).toEqual([
      ['insert', [['update', 'A', 0, 1]]],
      [
        'insertAll',
        [
          ['update', 'A', 1, 3],
          ['update', 'B', 0, 1],
        ],
      ],
      [
        're-parent',
        [
          ['update', 'A', 3, 2],
          ['update', 'B', 1, 2],
        ],
      ],
      ['soft delete', [['update', 'A', 2, 1]]],
      ['delete', [['update', 'A', 1, 0]]],
      ['no key touched', []],
      // A filter names no rows: the parent is re-read, and its `before` is unknown — `null`.
      ['deleteWhere, key pinned', [['update', 'B', null, 0]]],
      ['insert again', [['update', 'A', 0, 1]]],
      ['updateWhere, key unpinned', [['bulk', 'update', 1]]],
      ['updateWhere, nothing counted', []],
    ]);
    expect(memory).toEqual(postgres);
  });

  test('with no row subscriber a counted write sends one statement and reads no parent', async () => {
    await empty();
    const db = database(ENTITIES, { driver: postgresDriver() });
    await db.posts.insert({ id: A, title: 'a' });
    const statements: string[] = [];
    subscribe('db.statement', ({ payload }) => void statements.push(payload.text));
    await db.likes.insert({ id: like(9), postId: A, deletedAt: null });
    expect(statements).toHaveLength(1);
  });

  test('the parent change is told at COMMIT, and never after a rollback', async () => {
    const db = database(ENTITIES, { driver: memoryDriver() });
    await db.posts.insert({ id: A, title: 'a' });
    const heard: (number | null)[] = [];
    subscribe('entity.row', ({ payload }) => {
      if (payload.entity === posts.$name) heard.push(count(payload.after));
    });
    const tx = memoryTransactor();
    await tx.run(async (open) => {
      await db.likes.insert({ id: like(1), postId: A, deletedAt: null }, { tx: open });
      expect(heard).toEqual([]);
    });
    expect(heard).toEqual([1]);
    await tx
      .run(async (open) => {
        await db.likes.insert({ id: like(2), postId: A, deletedAt: null }, { tx: open });
        // The rollback is the transactor's answer to a rejected unit of work: input, not a verdict.
        return Promise.reject(new RangeError('rolled back'));
      })
      .catch(() => undefined);
    expect(heard).toEqual([1]);
  });

  test('a tenanted parent is read back in the tenant the child row names', async () => {
    const db = database({ notes, stars }, { driver: memoryDriver() });
    const org = '00000000-0000-7000-8000-0000000000f1';
    await db.notes.insert({ id: A, orgId: org }, { orgId: org });
    const heard: (number | null)[] = [];
    subscribe('entity.row', ({ payload }) => {
      if (payload.entity === notes.$name) heard.push(Number(payload.after?.['stars']));
    });
    subscribe('entity.bulk', ({ payload }) => {
      if (payload.entity === notes.$name) heard.push(null);
    });
    await db.stars.insert({ id: like(1), orgId: org, noteId: A });
    await db.stars.deleteWhere({ orgId: org, noteId: A });
    expect(heard).toEqual([1, 0]);
  });
});
