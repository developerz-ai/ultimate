// Entity conformance · walking and joining: `inBatches(size)` cuts one seed into the same batches
// and its cursor resumes at the same row, a numeric key found under any spelling, and `preload`
// attaching the same rows — `null` for a key that resolves to nothing, `[]` for an empty hasMany.
// Lifted from `entity/src/{batch,preload}-parity.test.ts`.

import { expect } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import type { BatchIterator } from '@ultimat3/entity';
import { bigint, decimal, entity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const walked = remember(
  entity('ec_p_walked', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 80 }) },
  }),
);

const bigs = remember(
  entity('ec_p_bigs', { columns: { id: bigint().primaryKey(), label: text({ max: 8 }) } }),
);
const ints = remember(
  entity('ec_p_ints', { columns: { id: integer().primaryKey(), label: text({ max: 8 }) } }),
);
const decimals = remember(
  entity('ec_p_decimals', { columns: { id: decimal().primaryKey(), label: text({ max: 8 }) } }),
);

const orgs = remember(
  entity('ec_p_orgs', { columns: { id: uuid().primaryKey(), slug: text({ max: 40 }) } }),
);

const members = remember(
  entity('ec_p_members', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid()
        .references(() => orgs.id)
        .tenant(),
      email: text({ max: 120 }),
      deletedAt: timestamp().nullable(),
    },
  }),
);

const posts = remember(
  entity('ec_p_posts', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid()
        .references(() => orgs.id)
        .tenant(),
      authorId: uuid().references(() => members.id),
      reviewerId: uuid()
        .references(() => members.id)
        .nullable(),
      title: text({ max: 120 }),
    },
  }),
);

const ORG = idAt(1);
const SEED = Array.from({ length: 6 }, (_, index) => ({
  id: idAt(200 + index),
  orgId: ORG,
  title: `Post ${index}`,
}));
const ids = (batches: readonly (readonly { readonly id: string }[])[]) =>
  batches.flat().map((row) => row.id);

const drain = async <Row>(batches: BatchIterator<Row>): Promise<Row[][]> => {
  const seen: Row[][] = [];
  for await (const batch of batches) seen.push([...batch]);
  return seen;
};

/** A point read batches only inside a request's context: `coalesce.ts` keys on it. */
const inRequest = <T>(read: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), read);

const batches: readonly EntityDriverCheck[] = [
  checkOver(
    { walked },
    'inBatches cuts one seed into the same batches, in key order',
    async (db) => {
      await db.walked.insertAll(SEED);
      const even = await drain(db.walked.where({ orgId: ORG }).inBatches(2));
      const uneven = await drain(db.walked.where({ orgId: ORG }).inBatches(4));
      expect([even.map((batch) => batch.length), uneven.map((batch) => batch.length)]).toEqual([
        [2, 2, 2],
        [4, 2],
      ]);
      expect([ids(even), ids(uneven)]).toEqual([
        SEED.map((row) => row.id),
        SEED.map((row) => row.id),
      ]);
    },
  ),
  checkOver(
    { walked },
    'a batch cursor resumes at the next row: nothing repeated, nothing skipped',
    async (db) => {
      await db.walked.insertAll(SEED);
      const walk = db.walked.where({ orgId: ORG }).inBatches(2);
      const first: { id: string }[] = [];
      for await (const batch of walk) {
        first.push(...batch);
        break;
      }
      const rest = await drain(db.walked.where({ orgId: ORG }).after(walk.cursor).inBatches(2));
      expect([...first.map((row) => row.id), ...ids(rest)]).toEqual(SEED.map((row) => row.id));
    },
  ),
  checkOver(
    { bigs, decimals, ints },
    'a numeric key is found under any spelling, alone or batched in one tick',
    async (db, { driver }) => {
      await db.bigs.insert({ id: '7', label: 'big' });
      await db.decimals.insert({ id: '2.5', label: 'dec' });
      await db.ints.insert({ id: 7, label: 'int' });
      const [big, dec, int] = [driver.repo(bigs), driver.repo(decimals), driver.repo(ints)];
      const label = async (read: () => Promise<{ readonly label: string } | null>) =>
        (await inRequest(read))?.label;
      for (const id of ['007', '+7', '7'])
        expect([id, await label(() => big.findById(id))]).toEqual([id, 'big']);
      for (const id of ['2.5', '2.50', '+02.500'])
        expect([id, await label(() => dec.findById(id))]).toEqual([id, 'dec']);
      const batched = await inRequest(() =>
        Promise.all([big.findById('007'), big.findById('+7'), big.findById('7')]),
      );
      expect(batched.map((row) => row?.label)).toEqual(['big', 'big', 'big']);
      // An integer key spelled as text is the number the column parses it as.
      expect(await label(() => int.findById('007' as never))).toBe('int');
    },
  ),
];

const [ANA, BEN, GONE] = [idAt(10), idAt(11), idAt(12)];
const [P1, P2, P3] = [idAt(20), idAt(21), idAt(22)];
/** A `hasMany` is named for the entity the rows come from, so both inbound keys take the long form. */
const [BY_AUTHOR, BY_REVIEWER] = ['ec_p_postsByAuthor', 'ec_p_postsByReviewer'];
const field = (row: unknown, key: string): unknown => (row as Record<string, unknown>)[key];
const idsIn = (rows: unknown): unknown =>
  (rows as readonly unknown[]).map((row) => field(row, 'id'));
const SET = { orgs, members, posts };

const preloads: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'belongsTo attaches the row, and null for a key that resolves to nothing',
    async (db) => {
      await db.orgs.insert({ id: ORG, slug: 'ours' });
      for (const id of [ANA, BEN, GONE])
        await db.members.insert({ id, orgId: ORG, email: `${id}@example.com` });
      await db.posts.insert({ id: P1, orgId: ORG, authorId: ANA, title: 'First' });
      await db.posts.insert({
        id: P2,
        orgId: ORG,
        authorId: ANA,
        reviewerId: BEN,
        title: 'Second',
      });
      await db.posts.insert({
        id: P3,
        orgId: ORG,
        authorId: BEN,
        reviewerId: GONE,
        title: 'Third',
      });
      // Soft-deleted: a key every store holds, that a read no longer resolves.
      await db.members.delete(GONE, { orgId: ORG });
      const rows = await db.posts
        .where({ orgId: ORG })
        .orderBy('id')
        .preload('author')
        .preload('reviewer')
        .all();
      expect(field(rows[0], 'author')).toMatchObject({ id: ANA });
      expect(Array.isArray(field(rows[0], 'author'))).toBe(false);
      expect([
        field(rows[0], 'reviewer'),
        field(rows[2], 'reviewer'),
        'reviewer' in (rows[2] as object),
      ]).toEqual([null, null, true]);
      expect(field(rows[1], 'reviewer')).toMatchObject({ id: BEN });
      const narrowed = await db.posts
        .where({ orgId: ORG })
        .orderBy('id')
        .select({ id: true, title: true })
        .preload('author')
        .all();
      expect(Object.keys(narrowed[0] as object).sort()).toEqual(['author', 'id', 'title']);
    },
  ),
  checkOver(SET, 'hasMany attaches an array in order, empty as [], never merged', async (db) => {
    await db.orgs.insert({ id: ORG, slug: 'ours' });
    for (const id of [ANA, BEN])
      await db.members.insert({ id, orgId: ORG, email: `${id}@example.com` });
    await db.posts.insert({ id: P1, orgId: ORG, authorId: ANA, title: 'First' });
    await db.posts.insert({ id: P2, orgId: ORG, authorId: ANA, reviewerId: BEN, title: 'Second' });
    await db.posts.insert({ id: P3, orgId: ORG, authorId: BEN, title: 'Third' });
    const rows = await db.members
      .where({ orgId: ORG })
      .orderBy('id')
      .preload(BY_AUTHOR)
      .preload(BY_REVIEWER)
      .all();
    expect([idsIn(field(rows[0], BY_AUTHOR)), field(rows[0], BY_REVIEWER)]).toEqual([[P1, P2], []]);
    expect([idsIn(field(rows[1], BY_AUTHOR)), idsIn(field(rows[1], BY_REVIEWER))]).toEqual([
      [P3],
      [P2],
    ]);
  }),
];

export const BATCH_CHECKS: readonly EntityDriverCheck[] = [...batches, ...preloads];
