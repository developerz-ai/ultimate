// A preloaded row against writes the DATABASE makes. `jit-preload.test.ts` proves a repository
// write to an entity drops its preloaded rows; this proves the rows a framework-declared trigger
// or foreign-key action rewrites are dropped too — the write names the child, the row that moved
// is the parent's. Embedded PGlite, migrated by the migration `x db gen` writes.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const authors = entity('jitdb_authors', {
  columns: { id: uuid().primaryKey(), name: text(), postCount: integer().default(0) },
});
const posts = entity('jitdb_posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => authors.id, { countedIn: () => authors.postCount }),
    title: text(),
  },
});
const reviews = entity('jitdb_reviews', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    body: text(),
  },
});
const likes = entity('jitdb_likes', {
  columns: {
    id: uuid().primaryKey(),
    reviewId: uuid().references(() => reviews.id, { onDelete: 'cascade' }),
  },
});

const client = pgliteClient();
const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AUTHOR = idAt(1);
const POST = idAt(10);
const REVIEW = idAt(20);
const LIKE = idAt(30);

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [authors.$describe(), posts.$describe(), reviews.$describe(), likes.$describe()],
    name: 'jit preload db writes',
    now: new Date('2026-11-07T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "jitdb_likes"'));
  await client.execute(raw('delete from "jitdb_reviews"'));
  await client.execute(raw('delete from "jitdb_posts"'));
  await client.execute(raw('delete from "jitdb_authors"'));
  await postgresRepo(authors).insert({ id: AUTHOR, name: 'a', postCount: 0 });
  await postgresRepo(posts).insert({ id: POST, authorId: AUTHOR, title: 'p' });
  await postgresRepo(reviews).insert({ id: REVIEW, postId: POST, body: 'r' });
  await postgresRepo(likes).insert({ id: LIKE, reviewId: REVIEW });
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: idAt(90) }) }), work);

describe('a row the database rewrites is not served from before the write', () => {
  test('a countedIn trigger: inserting a child is a write to its parent', async () => {
    const [before, after] = await inRequest(async () => {
      await postgresRepo(posts).findMany();
      const first = await postgresRepo(authors).findById(AUTHOR);
      await postgresRepo(posts).insert({ id: idAt(11), authorId: AUTHOR, title: 'q' });
      return [first, await postgresRepo(authors).findById(AUTHOR)];
    });

    expect(before?.postCount).toBe(1);
    expect(after?.postCount).toBe(2);
  });

  test('an onDelete cascade: deleting a parent is a write to its children', async () => {
    const [before, after] = await inRequest(async () => {
      await postgresRepo(likes).findMany();
      const first = await postgresRepo(reviews).findById(REVIEW);
      // The statement names posts; the review goes with the post, by the key's own rule.
      await postgresRepo(posts).delete(POST);
      return [first, await postgresRepo(reviews).findById(REVIEW)];
    });

    expect(before?.id).toBe(REVIEW);
    expect(after).toBeNull();
  });
});
