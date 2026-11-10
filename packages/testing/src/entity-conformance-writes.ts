// Entity conformance · single-row and filtered WRITES: an `undefined` patch value is absent, every
// key the table keeps is refused when repeated, a transition moves a row keyed by another column,
// and a column stores only what Postgres stores. Lifted from `entity/src/write-parity.test.ts`.

import { expect } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { SQLSTATE, sqlState } from '@ultimat3/db';
import {
  arrayOf,
  bigint,
  decimal,
  entity,
  enumerated,
  integer,
  invariant,
  json,
  t,
  text,
  timestamp,
  url,
  uuid,
} from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt, outcome } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const notes = remember(
  entity('ec_w_notes', {
    columns: {
      id: uuid().primaryKey(),
      title: text({ max: 40 }),
      body: text({ max: 40 }).nullable(),
    },
  }),
);

/** Soft-deleting: a patch can move a row out of the default read. */
const stamped = remember(
  entity('ec_w_stamped', {
    columns: {
      id: uuid().primaryKey(),
      title: text({ max: 40 }),
      deletedAt: timestamp().nullable(),
    },
  }),
);
const GONE_AT = new Date('2026-01-01T00:00:00.000Z');

const tags = remember(
  entity('ec_w_tags', {
    columns: { code: text({ max: 20 }).primaryKey(), slug: text({ max: 20 }) },
    indexes: [{ on: ['slug'], unique: true }],
  }),
);

const STATES = ['draft', 'live', 'archived'] as const;
const coupons = remember(
  entity('ec_w_coupons', {
    columns: {
      code: text({ max: 20 }).primaryKey(),
      status: enumerated(STATES)
        .transitions({ draft: ['live'], live: ['archived'], archived: [] })
        .default('draft'),
    },
  }),
);

const rates = remember(
  entity('ec_w_rates', {
    columns: {
      id: uuid().primaryKey(),
      rate: decimal({ precision: 8, scale: 2 }),
      loose: decimal().nullable(),
      big: bigint().nullable(),
    },
  }),
);

export const countries = remember(
  entity('ec_w_countries', {
    columns: {
      id: uuid().primaryKey(),
      iso: text({ max: 2 }),
      name: text({ max: 40 }),
      createdAt: timestamp().defaultNow(),
    },
    indexes: [{ on: ['iso'], unique: true }],
  }),
);

const links = remember(
  entity('ec_w_links', {
    columns: { id: uuid().primaryKey(), label: text({ max: 3 }), hits: integer(), href: url() },
  }),
);

/** A unique declared as an INVARIANT, a jsonb to key-test and an array whose elements may be NULL. */
const docs = remember(
  entity('ec_w_docs', {
    columns: {
      id: uuid().primaryKey(),
      slug: text({ max: 40 }),
      data: json(t.record(t.string)).nullable(),
      marks: arrayOf(text({ max: 20 }).nullable()).nullable(),
    },
    invariants: (c) => [invariant('ec_slug_unique', c.unique(['slug']))],
  }),
);

const ID = idAt(1);
/** A duplicate key: the framework's code AND Postgres' SQLSTATE, on every driver — a caller that
 * branches on `sqlState(error)` (an upsert retry, a "taken" message) must not see Postgres only. */
const DUPLICATE = { code: 'X_DB_UNIQUE_VIOLATION', sqlState: SQLSTATE.uniqueViolation };

/** The refusal's code and SQLSTATE, or the value when nothing was refused. */
const duplicate = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : 'uncoded', sqlState: sqlState(error) };
  }
};

const REFUSED = { code: 'X_INVARIANT_VIOLATED' };

const undefinedIsAbsent: readonly EntityDriverCheck[] = [
  checkOver({ notes }, 'update keeps a column the patch names as undefined', async (db) => {
    await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
    await db.notes.update(ID, { title: 'moved', body: undefined });
    expect(await db.notes.where({ id: ID }).one()).toEqual({
      id: ID,
      title: 'moved',
      body: 'kept body',
    });
  }),
  checkOver({ notes }, 'a patch naming only undefined values changes nothing', async (db) => {
    await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
    await outcome(() => db.notes.update(ID, { body: undefined }));
    expect(await db.notes.where({ id: ID }).one()).toEqual({
      id: ID,
      title: 'kept',
      body: 'kept body',
    });
  }),
  checkOver({ notes }, 'updateWhere keeps a column the patch names as undefined', async (db) => {
    await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
    await db.notes.updateWhere({ id: ID }, { title: 'moved', body: undefined });
    expect(await db.notes.where({ id: ID }).one()).toEqual({
      id: ID,
      title: 'moved',
      body: 'kept body',
    });
  }),
];

const keysAreKept: readonly EntityDriverCheck[] = [
  checkOver({ tags }, 'a duplicate primary key is refused, not a silent replace', async (db) => {
    await db.tags.insert({ code: 'a', slug: 'one' });
    expect(await duplicate(() => db.tags.insert({ code: 'a', slug: 'two' }))).toEqual(DUPLICATE);
    expect((await db.tags.all()).map((row) => row.slug)).toEqual(['one']);
  }),
  checkOver({ tags }, 'a duplicate unique column is refused', async (db) => {
    await db.tags.insert({ code: 'a', slug: 'one' });
    expect(await duplicate(() => db.tags.insert({ code: 'b', slug: 'one' }))).toEqual(DUPLICATE);
  }),
  checkOver({ tags }, 'insertAll with a duplicate inside the batch stores nothing', async (db) => {
    const batch = [
      { code: 'a', slug: 'one' },
      { code: 'a', slug: 'two' },
    ];
    expect(await duplicate(() => db.tags.insertAll(batch))).toEqual(DUPLICATE);
    expect(await db.tags.all()).toHaveLength(0);
  }),
  checkOver({ tags }, 'a patch moving the primary key leaves one row, not two', async (db) => {
    await db.tags.insert({ code: 'a', slug: 'one' });
    await db.tags.update('a', { code: 'z' });
    expect((await db.tags.all()).map((row) => row.code)).toEqual(['z']);
  }),
  checkOver({ stamped }, 'an update that soft-deletes answers the row it wrote', async (db) => {
    await db.stamped.insert({ id: ID, title: 'gone', deletedAt: null });
    const after = await db.stamped.update(ID, { deletedAt: GONE_AT });
    expect([after.id, after.deletedAt]).toEqual([ID, GONE_AT]);
    expect(await db.stamped.all()).toEqual([]);
  }),
  checkOver(
    { stamped },
    'an empty patch on a soft-deleted row is X_NOT_FOUND, never the row',
    async (db, { driver }) => {
      await db.stamped.insert({ id: ID, title: 'gone', deletedAt: null });
      await db.stamped.delete(ID);
      const repo = driver.repo(stamped);
      expect(await outcome(() => repo.update(ID, {}))).toEqual({ code: 'X_NOT_FOUND' });
      expect(await outcome(() => repo.update(ID, { title: undefined }))).toEqual({
        code: 'X_NOT_FOUND',
      });
      expect(await outcome(() => repo.update(ID, { title: 'back' }))).toEqual({
        code: 'X_NOT_FOUND',
      });
    },
  ),
  checkOver(
    { notes },
    'two results taking one primary key are refused; neither row moves',
    async (db) => {
      await db.notes.insert({ id: idAt(1), title: 'one', body: 'same' });
      await db.notes.insert({ id: idAt(2), title: 'two', body: 'same' });
      expect(
        await duplicate(() => db.notes.updateWhere({ body: 'same' }, { id: idAt(3) })),
      ).toEqual(DUPLICATE);
      const kept = (await db.notes.all()).map((row) => [row.id, row.title, row.body]).sort();
      expect(kept).toEqual([
        [idAt(1), 'one', 'same'],
        [idAt(2), 'two', 'same'],
      ]);
    },
  ),
  checkOver(
    { countries },
    'two results taking one unique value are refused; neither moves',
    async (db) => {
      await db.countries.insert({ id: idAt(1), iso: 'AA', name: 'Same' });
      await db.countries.insert({ id: idAt(2), iso: 'BB', name: 'Same' });
      expect(
        await duplicate(() => db.countries.updateWhere({ name: 'Same' }, { iso: 'ZZ' })),
      ).toEqual(DUPLICATE);
      const kept = (await db.countries.all()).map((row) => [row.id, row.iso]).sort();
      expect(kept).toEqual([
        [idAt(1), 'AA'],
        [idAt(2), 'BB'],
      ]);
    },
  ),
  checkOver({ docs }, 'a unique declared as an invariant refuses a second row', async (db) => {
    await db.docs.insert({ id: idAt(1), slug: 'one' });
    expect(await duplicate(() => db.docs.insert({ id: idAt(2), slug: 'one' }))).toEqual(DUPLICATE);
  }),
  checkOver(
    { docs },
    "an invariant unique refuses a patch onto another row's value and a batch pair",
    async (db) => {
      await db.docs.insert({ id: idAt(1), slug: 'one' });
      await db.docs.insert({ id: idAt(2), slug: 'two' });
      expect(await duplicate(() => db.docs.update(idAt(2), { slug: 'one' }))).toEqual(DUPLICATE);
      const pair = [
        { id: idAt(3), slug: 'three' },
        { id: idAt(4), slug: 'three' },
      ];
      expect(await duplicate(() => db.docs.insertAll(pair))).toEqual(DUPLICATE);
      expect((await db.docs.all()).map((row) => row.slug).sort()).toEqual(['one', 'two']);
    },
  ),
];

const transitions: readonly EntityDriverCheck[] = [
  checkOver({ coupons }, 'a transition moves a row keyed by another column', async (db) => {
    await db.coupons.insert({ code: 'SPRING', status: 'draft' });
    const moved = await db.coupons.transition('status', 'SPRING', { from: 'draft', to: 'live' });
    expect(moved).toEqual({ code: 'SPRING', status: 'live' });
  }),
  checkOver({ coupons }, 'a transition handed no id moves no row', async (db) => {
    await db.coupons.insert({ code: 'A', status: 'draft' });
    await db.coupons.insert({ code: 'B', status: 'draft' });
    for (const missing of [undefined, null]) {
      const move = { from: 'draft', to: 'live' } as const;
      const refused = await outcome(() =>
        db.coupons.transition('status', missing as unknown as string, move),
      );
      expect(refused).toEqual({ code: 'X_NOT_FOUND' });
    }
    expect((await db.coupons.all()).map((row) => row.status)).toEqual(['draft', 'draft']);
  }),
];

const decimals: readonly EntityDriverCheck[] = [
  checkOver({ rates }, 'a decimal reads back as one canonical string at its scale', async (db) => {
    const cases = [
      ['007.5', '7.50'],
      ['2.5', '2.50'],
      ['-0', '0.00'],
      ['-0.00', '0.00'],
      ['12', '12.00'],
    ];
    for (const [index, [given, canonical]] of cases.entries()) {
      const id = idAt(index + 1);
      await db.rates.insert({ id, rate: given as string });
      expect([given, (await db.rates.where({ id }).one())?.rate]).toEqual([given, canonical]);
    }
  }),
  checkOver({ rates }, 'an unbounded decimal and a bigint read back canonical', async (db) => {
    const loose = [
      ['007.50', '7.50'],
      ['-0', '0'],
      ['-000.10', '-0.10'],
    ];
    const bigs = [
      ['007', '7'],
      ['-0', '0'],
      ['-007', '-7'],
    ];
    for (const [index, [given, canonical]] of loose.entries()) {
      const id = idAt(index + 1);
      await db.rates.insert({ id, rate: '1', loose: given as string });
      expect([given, (await db.rates.where({ id }).one())?.loose]).toEqual([given, canonical]);
    }
    for (const [index, [given, canonical]] of bigs.entries()) {
      const id = idAt(index + 11);
      await db.rates.insert({ id, rate: '1', big: given as string });
      expect([given, (await db.rates.where({ id }).one())?.big]).toEqual([given, canonical]);
    }
  }),
  checkOver({ rates }, 'a decimal past its scale or its precision stays refused', async (db) => {
    expect(await outcome(() => db.rates.insert({ id: ID, rate: '1.234' }))).toEqual(REFUSED);
    expect(await outcome(() => db.rates.insert({ id: ID, rate: '1234567.00' }))).toEqual(REFUSED);
    expect(await db.rates.all()).toHaveLength(0);
  }),
];

const LINK = { id: ID, label: 'abc', hits: 1, href: 'https://a.b' };

const columnBounds: readonly EntityDriverCheck[] = [
  checkOver({ links }, 'text past max and an integer outside int4 are refused', async (db) => {
    for (const over of [{ label: 'abcdef' }, { hits: 3_000_000_000 }, { hits: -2_147_483_649 }]) {
      expect([over, await outcome(() => db.links.insert({ ...LINK, ...over }))]).toEqual([
        over,
        REFUSED,
      ]);
    }
  }),
  checkOver({ links }, 'max counts code points, as char_length does', async (db) => {
    await db.links.insert({ ...LINK, label: '👍👍👍' });
    expect((await db.links.where({ id: ID }).one())?.label).toBe('👍👍👍');
  }),
  checkOver(
    { links },
    'an upper-case url scheme is stored in its canonical lower case',
    async (db) => {
      await db.links.insert({ ...LINK, href: 'HTTPS://a.b/Path' });
      expect((await db.links.where({ id: ID }).one())?.href).toBe('https://a.b/Path');
    },
  ),
];

export const WRITE_CHECKS: readonly EntityDriverCheck[] = [
  ...undefinedIsAbsent,
  ...keysAreKept,
  ...transitions,
  ...decimals,
  ...columnBounds,
];

/** Predicates over `docs`, beside the writes because they share its table. */
export { docs as conformanceDocs };
