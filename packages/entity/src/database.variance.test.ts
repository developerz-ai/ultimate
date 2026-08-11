/**
 * Pins the one type position that decides whether `database({ … })` is typed at all.
 *
 * `Invariant<T>.holds` used to be a `readonly holds: (row: T) => boolean` property. A
 * function-typed property is checked contravariantly, so `Invariant<Post>` was not assignable to
 * `Invariant<unknown>`, `Entity<Post, C>` was not assignable to `EntityCore`, `E` failed the
 * `EntitySet` constraint and fell back to it — every table in the app became `Table<unknown>` and
 * the reference app carried 36 cascading errors from this single line. Method syntax is bivariant,
 * which is what `EntityCore.$assert` beside it already relied on.
 *
 * The compile-time half is in `type-pins.ts`, because `tsconfig.json` excludes `*.test.ts` and a
 * type assertion `tsc` never reads cannot fail. What is pinned here is the behaviour that proves
 * the handle is real: the row a typed table returns is the row the entity derived.
 */
import { afterAll, expect, test } from 'bun:test';
import { integer, text, uuid } from './columns';
import type { EntitySet } from './database';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const post = entity('variance_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
  },
  invariants: (c) => [invariant('like_count_non_negative', c.likeCount.atLeast(0))],
});

type Post = typeof post.$row;

// The constraint `database()` applies. It failed here first, before any call site.
const entities = { post } satisfies EntitySet;

const ORG = '00000000-0000-7000-8000-0000000000a1';

afterAll(() => {
  clearRegistry();
});

test('an entity with invariants still satisfies EntitySet', () => {
  expect(entities.post.$name).toBe('variance_test_posts');
  expect(entities.post.$invariants.map((rule) => rule.name)).toEqual(['like_count_non_negative']);
});

test('database() hands back the entity own row type, not unknown', async () => {
  const db = database({ post }, { driver: memoryDriver() });
  const created = await db.post.insert({
    id: '00000000-0000-7000-8000-000000000001',
    orgId: ORG,
    title: 'Hello',
  });
  // Typed, not `unknown`: an annotated binding is the assertion — `Table<unknown>` would make
  // `created` `unknown` and this line a compile error, which is the degradation being pinned.
  const row: Post = created;
  expect(row.title).toBe('Hello');
  expect(row.likeCount).toBe(0);

  const found: Post | null = await db.post.where({ orgId: ORG }).one();
  expect(found?.id).toBe(row.id);
});

test('the typed handle still runs the entity invariants on write', async () => {
  const db = database({ post }, { driver: memoryDriver() });
  await expect(
    db.post.insert({
      id: '00000000-0000-7000-8000-000000000002',
      orgId: ORG,
      title: 'Bad',
      likeCount: -1,
    }),
  ).rejects.toThrow(/like_count_non_negative/);
});
