// Entity conformance · a `countedIn` counter is a write to its PARENT, and the row observer says so:
// a child insert, delete or re-parent reports `entity.row` for each parent whose count moved, its
// `before` and `after` the stored row; a bulk child write pinned to one parent reports that row, one
// spanning several a bulk count — never silence, and never a change a rolled-back write did not make.

import { expect } from 'bun:test';
import type { EntityRowEvent } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { Database } from '@ultimat3/entity';
import { entity, integer, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { codeOf, handleOf, idAt } from './entity-conformance-support';
import { accountedFor, heard } from './entity-conformance-write-support';
import type { EntityDriverCheck, EntityDriverRun } from './entity-driver-conformance';

const posts = remember(
  entity('ec_ci_posts', {
    columns: { id: uuid().primaryKey(), title: text({ max: 20 }), likeCount: integer().default(0) },
  }),
);

const likes = remember(
  entity('ec_ci_likes', {
    columns: {
      id: uuid().primaryKey(),
      postId: uuid().references(() => posts.id, { countedIn: () => posts.likeCount }),
      reaction: text({ max: 20 }),
    },
  }),
);

const SET = { posts, likes };
type Db = Database<typeof SET>;
const PARENT = 'ec_ci_posts';
const [P1, P2] = [idAt('f1'), idAt('f2')];
const [L1, L2, L3] = [idAt('f11'), idAt('f12'), idAt('f13')];

const seedPosts = async (db: Db): Promise<void> => {
  await db.posts.insertAll([
    { id: P1, title: 'one', likeCount: 0 },
    { id: P2, title: 'two', likeCount: 0 },
  ]);
};

/** A row event as the three facts that matter: which parent, and its count before and after. */
const moved = (event: EntityRowEvent) => [
  event.op,
  event.after?.['id'] ?? event.before?.['id'],
  event.before?.['likeCount'] ?? null,
  event.after?.['likeCount'] ?? null,
];

const stored = async (db: Db) =>
  (await db.posts.orderBy('id').all()).map((row) => [row.id, row.likeCount]);

/**
 * A check over a store that keeps the counter. One that does not (`defineDriver`: no lifecycle
 * hook) refuses the counted child's repository outright, so there is no handle to build and no
 * parent change to report: its claim is the refusal check below, never these.
 */
const counted = (
  name: string,
  run: (db: Db, raw: EntityDriverRun) => Promise<void>,
  needs: EntityDriverCheck['needs'] = [],
): EntityDriverCheck => ({
  name,
  entities: Object.values(SET),
  needs,
  run: async (raw) => {
    if (!raw.counters) return;
    await run(handleOf(SET, raw.driver), raw);
  },
});

/** `[code, capability]` a build refused with, or `'built'`. */
const builds = (build: () => unknown): unknown => {
  try {
    build();
    return 'built';
  } catch (error) {
    return isUltimateError(error) ? [error.code, error.meta?.['capability']] : String(error);
  }
};

const refusal: readonly EntityDriverCheck[] = [
  {
    name: 'a store that keeps no counter refuses the counted child, never a count left stale',
    entities: Object.values(SET),
    run: async (raw) => {
      const child = builds(() => raw.driver.repo(likes));
      // The parent declares no counter of its own: every store builds it.
      expect([child, builds(() => raw.driver.repo(posts))]).toEqual([
        raw.counters ? 'built' : ['X_DRIVER_UNSUPPORTED', 'countedIn'],
        'built',
      ]);
    },
  },
];

const rows: readonly EntityDriverCheck[] = [
  counted(
    'a counted child insert and delete each report the parent row, its count before and after',
    async (db) => {
      await seedPosts(db);
      const insert = await heard(PARENT, () =>
        db.likes.insert({ id: L1, postId: P1, reaction: 'up' }),
      );
      const again = await heard(PARENT, () =>
        db.likes.insert({ id: L2, postId: P1, reaction: 'up' }),
      );
      const remove = await heard(PARENT, () => db.likes.delete(L1));
      expect([insert, again, remove].map((each) => each.heard.rows.map(moved))).toEqual([
        [['update', P1, 0, 1]],
        [['update', P1, 1, 2]],
        [['update', P1, 2, 1]],
      ]);
      expect([insert, again, remove].map((each) => each.heard.bulk)).toEqual([[], [], []]);
      expect(await stored(db)).toEqual([
        [P1, 1],
        [P2, 0],
      ]);
    },
  ),
  counted(
    'a re-parenting update reports both parents: the one it left and the one it joined',
    async (db) => {
      await seedPosts(db);
      await db.likes.insert({ id: L1, postId: P1, reaction: 'up' });
      const { heard: told } = await heard(PARENT, () => db.likes.update(L1, { postId: P2 }));
      expect(told.rows.map(moved).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual(
        [
          ['update', P1, 1, 0],
          ['update', P2, 0, 1],
        ],
      );
      expect(await stored(db)).toEqual([
        [P1, 0],
        [P2, 1],
      ]);
    },
  ),
  counted('an update leaving the counted key alone reports no parent change', async (db) => {
    await seedPosts(db);
    await db.likes.insert({ id: L1, postId: P1, reaction: 'up' });
    const { heard: told } = await heard(PARENT, () => db.likes.update(L1, { reaction: 'down' }));
    expect([told.rows.map(moved), told.bulk]).toEqual([[], []]);
  }),
];

const bulk: readonly EntityDriverCheck[] = [
  counted(
    'a bulk child delete pinned to one parent reports that parent row, by filter or by chain',
    async (db) => {
      await seedPosts(db);
      const three = () =>
        db.likes.insertAll([
          { id: L1, postId: P1, reaction: 'up' },
          { id: L2, postId: P1, reaction: 'up' },
          { id: L3, postId: P2, reaction: 'up' },
        ]);
      await three();
      const filter = await heard(PARENT, () => db.likes.deleteWhere({ postId: P1 }));
      await db.likes.deleteWhere({ postId: P2 });
      await three();
      const chain = await heard(PARENT, () =>
        db.likes.where({ postId: P1, reaction: 'up' }).deleteAll(),
      );
      // Pinned, the parent is known and re-read; by how much is not, so `before` is unknown (null).
      for (const [how, pinned] of [
        ['deleteWhere', filter],
        ['chain deleteAll', chain],
      ] as const) {
        expect([how, pinned.answer, pinned.heard.rows.map(moved), pinned.heard.bulk]).toEqual([
          how,
          2,
          [['update', P1, null, 0]],
          [],
        ]);
      }
      expect(await stored(db)).toEqual([
        [P1, 0],
        [P2, 1],
      ]);
    },
  ),
  counted(
    'a bulk child delete across parents reports a bulk count for the parent table, never silence',
    async (db) => {
      await seedPosts(db);
      await db.likes.insertAll([
        { id: L1, postId: P1, reaction: 'up' },
        { id: L2, postId: P1, reaction: 'up' },
        { id: L3, postId: P2, reaction: 'up' },
      ]);
      const spread = await heard(PARENT, () => db.likes.where({ reaction: 'up' }).deleteAll());
      expect(spread.answer).toBe(3);
      expect(spread.heard.bulk.map((each) => [each.entity, each.op])).toEqual([[PARENT, 'update']]);
      // Two parents moved: a count a subscriber re-reads on may be wider, never narrower.
      expect(accountedFor(spread.heard)).toBeGreaterThanOrEqual(2);
      expect(await stored(db)).toEqual([
        [P1, 0],
        [P2, 0],
      ]);
    },
  ),
  counted(
    'a counted child write rolled back with its transaction reports no parent change',
    async (db, { driver }) => {
      await seedPosts(db);
      await db.likes.insert({ id: L1, postId: P1, reaction: 'up' });
      const { answer, heard: told } = await heard(PARENT, () =>
        codeOf(() =>
          driver.transactor().run(async () => {
            await db.likes.insert({ id: L2, postId: P1, reaction: 'up' });
            await db.likes.insert({ id: L1, postId: P2, reaction: 'dup' });
          }),
        ),
      );
      expect([answer, told.rows.map(moved), told.bulk]).toEqual(['X_DB_UNIQUE_VIOLATION', [], []]);
      expect(await stored(db)).toEqual([
        [P1, 1],
        [P2, 0],
      ]);
    },
    ['transactions'],
  ),
];

export const COUNTED_IN_CHECKS: readonly EntityDriverCheck[] = [...refusal, ...rows, ...bulk];
