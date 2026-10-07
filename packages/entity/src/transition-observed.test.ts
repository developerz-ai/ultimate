// Issue #702: a move conditional on the row its decision READ. The columns the decision consulted
// ride in the compare-and-set beside `id` and `from`, so a row reassigned between the read and the
// move matches no statement. One body against both drivers — `memoryDriver()` and `postgresDriver()`
// over an embedded Postgres (PGlite) — because a pin only one of them honours is a test that lies.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { enumerated, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const STATES = ['draft', 'published', 'archived'] as const;

const posts = entity('to_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: text({ max: 40 }),
    editorId: text({ max: 40 }).nullable(),
    status: enumerated(STATES)
      .transitions({ draft: ['published'], published: ['archived'], archived: [] })
      .default('draft'),
    // `defaultNow()` stores MICROSECONDS in Postgres and a decoded `Date` holds milliseconds, so
    // an equality pin on it would refuse every move there and none here.
    createdAt: timestamp().defaultNow(),
  },
});

const ENTITIES = { posts };
type Db = ReturnType<typeof database<typeof ENTITIES>>;
type Post = typeof posts.$row;
const client = pgliteClient();
const ID = '00000000-0000-7000-8000-000000000702';
const OTHER = '00000000-0000-7000-8000-000000000703';

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [posts.$describe()],
    name: 'transition observed',
    now: new Date('2026-10-07T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

/** One body against both drivers, seeded alike; memory's answer first. */
const both = async <T>(
  body: (db: Db, read: Post, driver: 'memory' | 'postgres') => Promise<T>,
): Promise<readonly [T, T]> => {
  const run = async (db: Db, driver: 'memory' | 'postgres'): Promise<T> => {
    await db.posts.insert({ id: OTHER, authorId: 'u-other' });
    return body(db, await db.posts.insert({ id: ID, authorId: 'u-author' }), driver);
  };
  const memory = await run(database(ENTITIES, { driver: memoryDriver() }), 'memory');
  await client.execute(raw('delete from "to_posts"'));
  return [memory, await run(database(ENTITIES, { driver: postgresDriver() }), 'postgres')] as const;
};

/** The code and cause of a refusal, or the moved state. */
const outcome = async (run: () => Promise<Post>): Promise<string> => {
  try {
    return (await run()).status;
  } catch (error) {
    if (error instanceof UltimateError) return `${error.code}: ${error.cause}`;
    return expect.unreachable('not an UltimateError');
  }
};

const publish = (db: Db, row: unknown, read: readonly string[]) =>
  outcome(() =>
    db.posts.transition('status', ID, {
      from: 'draft',
      to: 'published',
      observed: { row, read },
    }),
  );

describe('Table.transition({ observed }) — the decision is part of the compare-and-set', () => {
  test('a column the decision read, changed before the move, refuses it in both drivers', async () => {
    const answers = await both(async (db, read) => {
      await db.posts.update(ID, { authorId: 'u-thief' });
      const answer = await publish(db, read, ['authorId']);
      const after = await db.posts.where({ id: ID }).one();
      return [answer, after?.status];
    });
    for (const [answer, status] of answers) {
      expect(answer).toStartWith('X_STATE_CONFLICT');
      // Names the column that moved, never its value: the value is row data.
      expect(answer).toContain('authorId');
      expect(answer).not.toContain('u-thief');
      expect(status).toBe('draft');
    }
  });

  test('an unchanged row moves, and a null the decision read is pinned as null', async () => {
    const answers = await both(async (db, read) => [
      await publish(db, read, ['authorId', 'editorId']),
    ]);
    expect(answers).toEqual([['published'], ['published']]);

    const refused = await both(async (db, read) => {
      await db.posts.update(ID, { editorId: 'u-late' });
      return publish(db, read, ['editorId']);
    });
    for (const answer of refused) expect(answer).toStartWith('X_STATE_CONFLICT');
  });

  test('a column the decision did NOT read may change: only what was consulted is pinned', async () => {
    const answers = await both(async (db, read) => {
      await db.posts.update(ID, { editorId: 'u-late' });
      return publish(db, read, ['authorId']);
    });
    expect(answers).toEqual(['published', 'published']);
  });

  test('a moved state is still the state conflict, naming the state the row is in', async () => {
    const answers = await both(async (db, read) => {
      await db.posts.transition('status', ID, { from: 'draft', to: 'published' });
      return publish(db, read, ['authorId']);
    });
    for (const answer of answers) {
      expect(answer).toStartWith('X_STATE_CONFLICT');
      expect(answer).toContain('"published"');
    }
  });

  test('a row that is not the one moved pins nothing — the decision was about another record', async () => {
    const answers = await both(async (db) => {
      const other = await db.posts.where({ id: OTHER }).one();
      await db.posts.update(ID, { authorId: 'u-thief' });
      return publish(db, other, ['authorId']);
    });
    expect(answers).toEqual(['published', 'published']);
  });

  test('a projection that carries no key is THIS row — the loader was handed its id', async () => {
    const answers = await both(async (db) => {
      const projected = await db.posts.where({ id: ID }).select({ authorId: true }).one();
      await db.posts.update(ID, { authorId: 'u-thief' });
      return publish(db, projected, ['authorId']);
    });
    for (const answer of answers) expect(answer).toStartWith('X_STATE_CONFLICT');
  });

  test('a timestamptz the decision read is not pinned, so Postgres microseconds refuse nothing', async () => {
    const answers = await both(async (db, _, driver) => {
      // What a server-side default or another writer stores: six fractional digits, which the
      // decoded `Date` this read hands back cannot hold.
      if (driver === 'postgres') {
        await client.execute(
          raw('update "to_posts" set created_at = \'2026-10-07 09:00:00.123456+00\''),
        );
      }
      const read = await db.posts.where({ id: ID }).one();
      return publish(db, read, ['createdAt']);
    });
    expect(answers).toEqual(['published', 'published']);
  });

  test('a property that names no column, and the key and machine column, add no pin', async () => {
    const answers = await both(async (db, read) =>
      publish(db, { ...read, extra: 1 }, ['extra', 'id', 'status', 'nope']),
    );
    expect(answers).toEqual(['published', 'published']);
  });
});
