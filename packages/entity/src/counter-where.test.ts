// `countedIn: { to, where }`: the predicate is compiled ONCE — to the description `@ultimat3/db`
// turns into the trigger's condition and the recount's truth — and Postgres (embedded PGlite,
// migrated by the migration `x db gen` writes) counts only the children it holds over. The bare
// thunk keeps working; a predicate the database cannot be told is refused at describe.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError, resetInstrumentation, subscribe } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { whereColumns } from './counter';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const posts = entity('cntw_posts', {
  columns: {
    id: uuid().primaryKey(),
    upCount: integer().default(0),
    allCount: integer().default(0),
  },
});
const votes = entity('cntw_votes', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, {
      onDelete: 'cascade',
      countedIn: { to: () => posts.upCount, where: () => whereColumns(votes).voteKind.eq('up') },
    }),
    otherPostId: uuid()
      .nullable()
      .references(() => posts.id, { countedIn: () => posts.allCount }),
    voteKind: text().nullable(),
  },
});

const ENTITIES = { posts, votes };
const client = pgliteClient();
const A = '00000000-0000-7000-8000-00000000000a';
const vote = (n: number): string =>
  `00000000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [posts.$describe(), votes.$describe()],
    name: 'counter where',
    now: new Date('2026-11-14T00:00:00.000Z'),
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

const script = async (db: Db): Promise<readonly (readonly [string, number, number])[]> => {
  const seen: (readonly [string, number, number])[] = [];
  const read = async (step: string) => {
    const row = await db.posts.where({ id: A }).one();
    seen.push([step, row?.upCount ?? -1, row?.allCount ?? -1]);
  };
  await db.posts.insert({ id: A });
  await db.votes.insertAll(
    (['up', 'up', 'down', null] as const).map((voteKind, n) => ({
      id: vote(n),
      postId: A,
      otherPostId: A,
      voteKind,
    })),
  );
  await read('insertAll');
  await db.votes.update(vote(2), { voteKind: 'up' });
  await read('flip in');
  await db.votes.update(vote(0), { voteKind: null });
  await read('flip to null');
  await db.votes.deleteWhere({ voteKind: 'up' });
  await read('deleteWhere');
  return seen;
};

const run = async (driver: Driver) => {
  await client.execute(raw('delete from "cntw_votes"'));
  await client.execute(raw('delete from "cntw_posts"'));
  return script(database(ENTITIES, { driver }));
};

const POSTGRES = [
  ['insertAll', 2, 4],
  ['flip in', 3, 4],
  ['flip to null', 2, 4],
  ['deleteWhere', 0, 2],
] as const;

describe('counts · where', () => {
  test('the description carries the predicate once, over the child aliased c', () => {
    expect(posts.$describe().counts).toEqual([
      {
        column: 'up_count',
        key: 'id',
        table: 'cntw_votes',
        references: 'post_id',
        softDelete: null,
        where: { sql: `c."vote_kind" = 'up'`, columns: ['vote_kind'] },
      },
      {
        column: 'all_count',
        key: 'id',
        table: 'cntw_votes',
        references: 'other_post_id',
        softDelete: null,
      },
    ]);
  });

  test('Postgres counts only the children the predicate holds over', async () => {
    expect(await run(postgresDriver())).toEqual(POSTGRES);
  });

  test('memory answers as Postgres does', async () => {
    expect(await run(memoryDriver())).toEqual(POSTGRES);
  });
});

describe('counts · where · the parent change is reported only when the count moved', () => {
  afterEach(() => resetInstrumentation());

  test('an uncounted child is silent; flipping it into the predicate is the parent update', async () => {
    const db = database(ENTITIES, { driver: memoryDriver() });
    await db.posts.insert({ id: A });
    const heard: string[] = [];
    subscribe('entity.row', ({ payload }) => {
      if (payload.entity === posts.$name) heard.push(`row ${String(payload.after?.['upCount'])}`);
    });
    subscribe('entity.bulk', ({ payload }) => {
      if (payload.entity === posts.$name) heard.push('bulk');
    });
    await db.votes.insert({ id: vote(9), postId: A, otherPostId: null, voteKind: 'down' });
    expect(heard).toEqual([]);
    await db.votes.update(vote(9), { voteKind: 'up' });
    expect(heard).toEqual(['row 1']);
    // A filtered write that sets only the predicate's column still moves the count.
    await db.votes.updateWhere({ id: vote(9) }, { voteKind: 'down' });
    expect(heard).toEqual(['row 1', 'bulk']);
  });
});

describe('counts · where · refused', () => {
  const code = (work: () => unknown): string => {
    try {
      work();
    } catch (error) {
      return isUltimateError(error) ? error.code : 'uncoded';
    }
    return 'accepted';
  };

  // Last: once registered, a refused counter refuses every reading of the counters, as it should.
  test('an app-only predicate is refused: the trigger could not hold the same rule', () => {
    const stray = entity('cntw_stray', {
      columns: {
        id: uuid().primaryKey(),
        postId: uuid().references(() => posts.id, {
          countedIn: {
            to: () => posts.upCount,
            where: () => whereColumns(stray).label.matches((value) => value.length > 0),
          },
        }),
        label: text(),
      },
    });
    expect(code(() => stray.$describe())).toBe('X_ENTITY_COUNTS_INVALID');
  });
});
