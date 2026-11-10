// Entity conformance · MANY-ROW writes: all or nothing past the bind ceiling, an upsert that
// overwrites only what the caller named, a merge judged before it lands, a soft delete judged as
// the update it is, an append-only table refusing every rewrite, and a seed upsert's bookkeeping.
// Lifted from `entity/src/{bulk-write,append-only,write}-parity.test.ts`.

import { expect } from 'bun:test';
import type { Repo, RowPatch } from '@ultimat3/entity';
import { defineSeed, entity, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt } from './entity-conformance-support';
import { countries } from './entity-conformance-writes';
import type { EntityDriverCheck } from './entity-driver-conformance';

/** Primary key only: memory's unique check is a scan per row, and this batch is 40,000 of them. */
const wide = remember(
  entity('ec_b_wide', {
    columns: { id: text({ max: 20 }).primaryKey(), label: text({ max: 20 }) },
  }),
);

const notes = remember(
  entity('ec_b_notes', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      title: text({ max: 40 }),
      body: text({ max: 40 }).nullable(),
    },
  }),
);
type Note = typeof notes.$row;

const stampHasReason = (deletedAt: unknown, reason: unknown): boolean =>
  deletedAt === null || reason !== null;

/** A rule with no CHECK, over a column an upsert's set list spares and one it overwrites. */
const audited = remember(
  entity('ec_b_audited', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      reason: text({ max: 40 }).nullable(),
      deletedAt: timestamp().nullable(),
    },
    invariants: (c) => [
      invariant('ec_stamp_has_reason', c.satisfies(stampHasReason, ['deletedAt', 'reason'])),
    ],
  }),
);

/** Every kind of column `$parse` fills: a default, a nullable and a `defaultNow()`. */
const filled = remember(
  entity('ec_b_filled', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      title: text({ max: 40 }),
      label: text({ max: 20 }).default('dflt'),
      note: text({ max: 40 }).nullable(),
      createdAt: timestamp().defaultNow(),
    },
  }),
);

const stamps = remember(
  entity('ec_b_stamps', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 20 }).unique(),
      title: text({ max: 40 }),
      updatedAt: timestamp().defaultNow().onUpdateNow(),
    },
  }),
);

const pairs = remember(
  entity('ec_b_pairs', {
    columns: { first: text({ max: 20 }), second: text({ max: 20 }), label: text().default('d') },
    primaryKey: ['first', 'second'],
  }),
);

/** The same rule with a column two rows share, for a filtered delete that matches both. */
const sweep = remember(
  entity('ec_b_sweep', {
    columns: {
      id: uuid().primaryKey(),
      kind: text({ max: 20 }),
      reason: text({ max: 40 }).nullable(),
      deletedAt: timestamp().nullable(),
    },
    invariants: (c) => [
      invariant('ec_sweep_stamp_has_reason', c.satisfies(stampHasReason, ['deletedAt', 'reason'])),
    ],
  }),
);

const ledger = remember(
  entity('ec_b_ledger', {
    columns: { id: uuid().primaryKey(), account: text({ max: 20 }), amount: integer() },
    appendOnly: true,
  }),
);

const ID = idAt(1);
const OTHER = idAt(2);
const REFUSED = 'X_INVARIANT_VIOLATED';
const UPSERT = ['upsert'] as const;
const WHEN = new Date('2020-01-02T03:04:05.000Z');
const STORED = { code: 'a', label: 'kept', note: 'kept note', title: 'old', createdAt: WHEN };

const batches: readonly EntityDriverCheck[] = [
  checkOver({ wide }, 'a 40,000-row batch failing on a duplicate leaves no row', async (db) => {
    // 2 columns: past the 65,535 bind ceiling, so one statement cannot carry it.
    const batch = Array.from({ length: 40_000 }, (_, index) => ({
      id: `r${index === 35_000 ? 0 : index}`,
      label: 'l',
    }));
    expect(await codeOf(() => db.wide.insertAll(batch))).toBe('X_DB_UNIQUE_VIOLATION');
    expect(await db.wide.count()).toBe(0);
  }),
  checkOver({ notes }, 'an empty batch writes nothing and answers empty', async (db) => {
    expect(await db.notes.insertAll([])).toEqual([]);
    expect(await db.notes.count()).toBe(0);
  }),
  checkOver(
    { notes },
    'an empty upsert answers empty, and a target no unique covers is still refused',
    async (db) => {
      expect(await db.notes.upsertAll([], { onConflict: ['code'] })).toEqual([]);
      expect(await codeOf(() => db.notes.upsertAll([], { onConflict: ['title'] }))).toBe(REFUSED);
    },
    UPSERT,
  ),
];

const upserts: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'a present undefined in an upsert is absent: the stored column keeps its value',
    async (_db, { driver }) => {
      const repo: Repo<Note> = driver.repo(notes);
      await repo.insert({ id: ID, code: 'a', title: 'kept', body: 'kept body' });
      const incoming: RowPatch<Note> = { id: OTHER, code: 'a', title: 'moved', body: undefined };
      const [written] = await repo.upsertAll([incoming as Note], { onConflict: ['code'] });
      expect(written).toEqual({ id: ID, code: 'a', title: 'moved', body: 'kept body' });
    },
    UPSERT,
  ),
  checkOver(
    { notes },
    'a row writing undefined where another writes a value is an uneven batch',
    async (_db, { driver }) => {
      const uneven: readonly RowPatch<Note>[] = [
        { id: ID, code: 'a', title: 't', body: 'new' },
        { id: OTHER, code: 'b', title: 't', body: undefined },
      ];
      const call = () => driver.repo(notes).upsertAll(uneven as Note[], { onConflict: ['code'] });
      expect(await codeOf(call)).toBe(REFUSED);
    },
    UPSERT,
  ),
  checkOver(
    { audited },
    'a merged upsert breaking a JS-only rule is refused, and the row stays',
    async (_db, { driver }) => {
      const repo = driver.repo(audited);
      const row = { id: ID, code: 'a', reason: 'because', deletedAt: null as Date | null };
      await repo.insert(row);
      await repo.delete(ID);
      expect(
        await codeOf(() => repo.upsertAll([{ ...row, reason: null }], { onConflict: ['code'] })),
      ).toBe(REFUSED);
      const { rows } = await repo.findMany({ includeDeleted: true });
      expect(rows.map((one) => one.reason)).toEqual(['because']);
      // onMatch: 'nothing' merges nothing, so it has nothing to judge.
      const skipped = await repo.upsertAll([{ ...row, reason: null }], {
        onConflict: ['code'],
        onMatch: 'nothing',
      });
      expect(skipped).toEqual([]);
    },
    UPSERT,
  ),
  checkOver(
    { filled },
    'upsertAll overwrites what the caller named, never what $parse filled in',
    async (db) => {
      await db.filled.insert(STORED);
      const written = await db.filled.upsertAll(
        [
          { code: 'a', title: 'new' },
          { code: 'b', title: 'fresh' },
        ],
        { onConflict: ['code'] },
      );
      const shape = written.map((row) => [row.code, row.title, row.label, row.note]);
      expect(shape).toEqual([
        ['a', 'new', 'kept', 'kept note'],
        ['b', 'fresh', 'dflt', null],
      ]);
      expect(written[0]?.createdAt).toEqual(WHEN);
    },
    UPSERT,
  ),
  checkOver(
    { filled, pairs },
    'an uneven batch, or a set list naming only the target, is refused and writes nothing',
    async (db) => {
      await db.filled.insert(STORED);
      const uneven = [
        { code: 'a', title: 't', note: 'new' },
        { code: 'b', title: 't' },
      ];
      expect(await codeOf(() => db.filled.upsertAll(uneven, { onConflict: ['code'] }))).toBe(
        REFUSED,
      );
      expect(await db.filled.count()).toBe(1);
      const keysOnly = () =>
        db.pairs.upsertAll([{ first: 'a', second: 'b' }], { onConflict: ['first', 'second'] });
      expect(await codeOf(keysOnly)).toBe(REFUSED);
    },
    UPSERT,
  ),
  checkOver(
    { stamps },
    'onUpdateNow moves on an upsert collision, though no caller named it',
    async (db) => {
      const first = await db.stamps.insert({ code: 'a', title: 'one', updatedAt: WHEN });
      const [second] = await db.stamps.upsertAll([{ code: 'a', title: 'two' }], {
        onConflict: ['code'],
      });
      expect([first.updatedAt.getTime(), second?.updatedAt.getTime() === WHEN.getTime()]).toEqual([
        WHEN.getTime(),
        false,
      ]);
    },
    UPSERT,
  ),
  checkOver(
    { filled },
    "onMatch: 'nothing' inserts the new row and leaves the stored one",
    async (db) => {
      await db.filled.insert(STORED);
      const written = await db.filled.upsertAll(
        [
          { code: 'a', title: 'x' },
          { code: 'c', title: 'y' },
        ],
        { onConflict: ['code'], onMatch: 'nothing' },
      );
      expect(written.map((row) => [row.code, row.label])).toEqual([['c', 'dflt']]);
      expect((await db.filled.where({ code: 'a' }).one())?.title).toBe('old');
    },
    UPSERT,
  ),
];

const softDeletes: readonly EntityDriverCheck[] = [
  checkOver(
    { audited },
    'a soft delete that breaks a JS-only rule is refused; the row stays',
    async (_db, { driver }) => {
      const repo = driver.repo(audited);
      await repo.insert({ id: ID, code: 'a', reason: null, deletedAt: null });
      expect(await codeOf(() => repo.delete(ID))).toBe(REFUSED);
      expect(await repo.count({})).toBe(1);
    },
  ),
  checkOver(
    { sweep },
    'deleteWhere over a mixed set refuses as one; a passing one deletes',
    async (_db, { driver }) => {
      const repo = driver.repo(sweep);
      await repo.insertAll([
        { id: ID, kind: 'k', reason: 'fine', deletedAt: null },
        { id: OTHER, kind: 'k', reason: null, deletedAt: null },
      ]);
      expect(await codeOf(() => repo.deleteWhere({ kind: 'k' }))).toBe(REFUSED);
      expect(await repo.count({})).toBe(2);
      await repo.insert({ id: idAt(3), kind: 'j', reason: 'fine', deletedAt: null });
      expect(await repo.deleteWhere({ kind: 'j' })).toBe(1);
      expect(await repo.count({})).toBe(2);
    },
  ),
];

const appendOnly: readonly EntityDriverCheck[] = [
  checkOver(
    { ledger },
    'an append-only table refuses update, delete and their filtered forms',
    async (db) => {
      await db.ledger.insert({ id: ID, account: 'cash', amount: 100 });
      const rewrites: readonly (() => Promise<unknown>)[] = [
        () => db.ledger.update(ID, { amount: 1 }),
        () => db.ledger.delete(ID),
        () => db.ledger.updateWhere({ account: 'cash' }, { amount: 1 }),
        () => db.ledger.deleteWhere({ account: 'cash' }),
      ];
      for (const rewrite of rewrites) expect(await codeOf(rewrite)).toBe('X_ENTITY_APPEND_ONLY');
      expect((await db.ledger.all()).map((row) => row.amount)).toEqual([100]);
    },
  ),
  checkOver(
    { ledger },
    'an append-only table refuses an upsert, and appending still sums',
    async (db) => {
      await db.ledger.insert({ id: ID, account: 'cash', amount: 100 });
      const upsert = () =>
        db.ledger.upsertAll([{ id: ID, account: 'cash', amount: 1 }], { onConflict: ['id'] });
      expect(await codeOf(upsert)).toBe('X_ENTITY_APPEND_ONLY');
      await db.ledger.insert({ id: OTHER, account: 'cash', amount: -40 });
      expect(await db.ledger.sum('amount')).toBe('60');
    },
    ['upsert', 'aggregate:sum'],
  ),
];

const seeds: readonly EntityDriverCheck[] = [
  checkOver(
    { countries },
    'a seed upsert re-run is skipped, and a changed column is an update in place',
    async (_db, { driver }) => {
      let name = 'New Zealand';
      const seed = defineSeed('ec_countries', async ({ upsert }) => {
        await upsert(countries, { by: ['iso'] }, { iso: 'NZ', name });
      });
      await seed.run({ driver });
      expect((await seed.run({ driver })).metrics).toEqual({ inserted: 0, updated: 0, skipped: 1 });
      const before = (await driver.repo(countries).findMany({})).rows[0]?.id;
      name = 'Aotearoa New Zealand';
      expect((await seed.run({ driver })).metrics).toEqual({ inserted: 0, updated: 1, skipped: 0 });
      const after = (await driver.repo(countries).findMany({})).rows;
      expect(after.map((row): readonly unknown[] => [row.id, row.name])).toEqual([[before, name]]);
    },
    UPSERT,
  ),
  checkOver(
    { countries },
    'a seed dry run reports what the real run then does, and stores nothing',
    async (_db, { driver }) => {
      const seed = defineSeed('ec_countries_dry', async ({ upsert }) => {
        await upsert(countries, { by: ['iso'] }, { iso: 'NZ', name: 'New Zealand' });
        await upsert(countries, { by: ['iso'] }, { iso: 'NZ', name: 'New Zealand' });
      });
      const dry = await seed.run({ driver, dryRun: true });
      expect(dry.metrics).toEqual({ inserted: 1, updated: 0, skipped: 1 });
      expect((await driver.repo(countries).findMany({})).rows).toEqual([]);
      expect((await seed.run({ driver })).metrics).toEqual(dry.metrics);
    },
    ['upsert', 'transactions'],
  ),
  checkOver(
    { filled },
    'a seed upsert keeps a column the seed never mentioned',
    async (db, { driver }) => {
      await db.filled.insert({ code: 'a', title: 'old', label: 'kept', note: 'kept note' });
      const answers: unknown[] = [];
      const seed = defineSeed('ec_filled_replay', async ({ upsert }) => {
        answers.push(await upsert(filled, { by: ['code'] }, { code: 'a', title: 'new' }));
      });
      await seed.run({ driver });
      const row = await db.filled.where({ code: 'a' }).one();
      expect([...answers, [row?.title, row?.label, row?.note]]).toEqual([
        'updated',
        ['new', 'kept', 'kept note'],
      ]);
    },
    UPSERT,
  ),
];

export const BULK_CHECKS: readonly EntityDriverCheck[] = [
  ...batches,
  ...upserts,
  ...softDeletes,
  ...appendOnly,
  ...seeds,
];
