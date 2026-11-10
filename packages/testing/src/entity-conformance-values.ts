// Entity conformance · what a VALUE means: the JSON `null` in a NOT NULL jsonb column, a money
// minor unit spelled as a `bigint`, a null test on a whole money property, and a value rule that
// refuses before the row lands. Lifted from `entity/src/{json-null,money-write,invariant}-parity`.

import { expect } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { RowWrite } from '@ultimat3/entity';
import {
  bigint,
  decimal,
  entity,
  integer,
  invariant,
  json,
  money,
  t,
  text,
  url,
  uuid,
} from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, idAt, outcome } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const shape = t.object({ a: t.number });

const events = remember(
  entity('ec_v_events', {
    columns: {
      id: uuid().primaryKey(),
      code: text({ max: 10 }).unique(),
      /** NOT NULL in the table; `null` is a value the schema admits. */
      payload: json(t.nullable(shape)),
      /** Nullable in the table; `null` here is the column cleared. */
      note: json(shape).nullable(),
    },
  }),
);

/** NOT NULL, and the schema refuses `null`: the schema is what says so. */
const strict = remember(
  entity('ec_v_strict', { columns: { id: uuid().primaryKey(), payload: json(shape) } }),
);

const AMOUNT = 129_900;

/** `.eq()` compares with `===`, the one operator that tells `129900n` from `129900`. */
const invoices = remember(
  entity('ec_v_invoices', {
    columns: { id: uuid().primaryKey(), reference: text({ max: 40 }), total: money() },
    invariants: (c) => [invariant('ec_total_minor_is_the_amount', c.total.minor.eq(AMOUNT))],
  }),
);

const priced = remember(
  entity('ec_v_priced', { columns: { id: uuid().primaryKey(), price: money().nullable() } }),
);

const ledgers = remember(
  entity('ec_v_ledgers', {
    columns: {
      id: uuid().primaryKey(),
      total: bigint(),
      rate: decimal({ precision: 8, scale: 2 }),
      share: decimal({ precision: 2, scale: 2 }).nullable(),
      code: text({ max: 20 }),
      href: url().nullable(),
    },
    invariants: (c) => [
      invariant('ec_total_non_negative', c.total.atLeast(0)),
      invariant('ec_rate_fixed', c.rate.eq(1.5)),
      invariant('ec_code_is_x', c.code.trimmed().eq('x')),
    ],
  }),
);

const inOrder = (low: number, high: number): boolean => low <= high;

/** A rule only the app can judge: no CHECK exists, so the write is all that stands behind it. */
const ranges = remember(
  entity('ec_v_ranges', {
    columns: { id: uuid().primaryKey(), low: integer(), high: integer() },
    invariants: (c) => [invariant('ec_low_first', c.satisfies(inOrder, ['low', 'high']))],
  }),
);

const ID = idAt(1);
const REFUSED = { code: 'X_INVARIANT_VIOLATED' };

const jsonNull: readonly EntityDriverCheck[] = [
  checkOver({ events }, 'a JSON null in a NOT NULL column is stored by every write', async (db) => {
    await db.events.insert({ id: ID, code: 'a', payload: null });
    expect(await db.events.where({ id: ID }).one()).toEqual({
      id: ID,
      code: 'a',
      payload: null,
      note: null,
    });
    await db.events.insert({ id: idAt(2), code: 'b', payload: { a: 1 } });
    await db.events.update(idAt(2), { payload: null });
    await db.events.insertAll([{ code: 'c', payload: null }]);
    const rows = (await db.events.all()).map((row) => [row.code, row.payload]).sort();
    expect(rows).toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
    ]);
  }),
  checkOver(
    { events },
    'upsertAll stores a JSON null, new row and collision alike',
    async (db) => {
      await db.events.upsertAll([{ code: 'b', payload: null }], { onConflict: ['code'] });
      await db.events.insertAll([{ code: 'a', payload: { a: 1 } }]);
      await db.events.upsertAll([{ code: 'a', payload: null }], { onConflict: ['code'] });
      const rows = (await db.events.all()).map((row) => [row.code, row.payload]).sort();
      expect(rows).toEqual([
        ['a', null],
        ['b', null],
      ]);
    },
    ['upsert'],
  ),
  checkOver({ events }, 'a null test matches no row: the column holds no SQL NULL', async (db) => {
    await db.events.insert({ id: ID, code: 'a', payload: null });
    expect([
      (await db.events.where({ payload: null }).all()).length,
      (await db.events.andWhere('payload', 'is-null', null).all()).length,
      (await db.events.andWhere('payload', 'is-not-null', null).all()).length,
      (await db.events.andWhere('payload', 'neq', null).all()).length,
      (await db.events.andWhere('payload', 'in', [null]).all()).length,
      (await db.events.andWhere('payload', 'contains', null).all()).length,
    ]).toEqual([0, 0, 1, 1, 0, 1]);
  }),
  checkOver({ strict }, 'a schema that refuses null refuses it, by the column', async (db) => {
    const error: unknown = await db.strict.insert({ id: ID, payload: null as never }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const said = isUltimateError(error) ? `${error.code} ${error.cause}` : 'not refused';
    expect(said).toStartWith('X_INVARIANT_VIOLATED column.json:');
  }),
  checkOver(
    { events },
    'a nullable json null is SQL NULL: cleared, and absent alike',
    async (db) => {
      await db.events.insert({ id: ID, code: 'a', payload: { a: 1 }, note: { a: 2 } });
      await db.events.update(ID, { note: null });
      await db.events.insert({ id: idAt(2), code: 'b', payload: { a: 1 } });
      expect(await db.events.where({ id: ID }).one()).toEqual({
        id: ID,
        code: 'a',
        payload: { a: 1 },
        note: null,
      });
      expect((await db.events.where({ note: null }).all()).length).toBe(2);
    },
  ),
];

/** A minor unit read straight off a `bigint` column, reaching a write with no conversion. */
const wide = (): RowWrite<typeof invoices.$row> => ({
  id: ID,
  reference: 'INV-1',
  total: { minor: BigInt(AMOUNT), currency: 'EUR' },
});
const NARROW = { minor: AMOUNT, currency: 'EUR' };

const moneyWrites: readonly EntityDriverCheck[] = [
  checkOver(
    { invoices },
    'a bigint minor unit is narrowed before insert judges it',
    async (_db, { driver }) => {
      const written = wide();
      const row = await driver.repo(invoices).insert(written);
      expect(row.total).toEqual(NARROW);
      expect(JSON.parse(JSON.stringify(row)).total).toEqual(NARROW);
      // Narrowing copies; the row the caller built is theirs and is unchanged.
      expect(written.total).toEqual({ minor: BigInt(AMOUNT), currency: 'EUR' });
    },
  ),
  checkOver(
    { invoices },
    'insertAll judges the batch after narrowing it',
    async (_db, { driver }) => {
      const [row] = await driver.repo(invoices).insertAll([wide()]);
      expect(row?.total).toEqual(NARROW);
    },
  ),
  checkOver(
    { invoices },
    'upsertAll judges the incoming rows after narrowing them',
    async (_db, { driver }) => {
      const [row] = await driver.repo(invoices).upsertAll([wide()], { onConflict: ['id'] });
      expect(row?.total).toEqual(NARROW);
    },
    ['upsert'],
  ),
  checkOver({ priced }, 'a null test on a whole money property reads the amount', async (db) => {
    const [free, paid] = [idAt(11), idAt(12)];
    await db.priced.insert({ id: free, price: null });
    await db.priced.insert({ id: paid, price: { minor: 100, currency: 'EUR' } });
    const ids = async (op: 'neq' | 'is-null' | 'is-not-null'): Promise<readonly string[]> =>
      (await db.priced.andWhere('price', op, null).all()).map((row) => row.id);
    expect((await db.priced.where({ price: null }).all()).map((row) => row.id)).toEqual([free]);
    expect([await ids('neq'), await ids('is-null'), await ids('is-not-null')]).toEqual([
      [paid],
      [free],
      [paid],
    ]);
    const part = await db.priced.andWhere('price.minor' as never, 'is-null', null).all();
    expect(part.map((row) => row.id)).toEqual([free]);
    // An amount compared whole is refused, rows or none: no single column holds one.
    const amount = { minor: 100, currency: 'EUR' };
    expect(await outcome(() => db.priced.where({ price: amount }).all())).toEqual(REFUSED);
    await db.priced.deleteWhere({ id: paid });
    await db.priced.deleteWhere({ id: free });
    expect(await outcome(() => db.priced.where({ price: amount }).all())).toEqual(REFUSED);
  }),
];

const GOOD = { id: ID, total: '5', rate: '1.5', code: 'x' };

const valueRules: readonly EntityDriverCheck[] = [
  checkOver(
    { ledgers },
    "a numeric rule over bigint and decimal: '5' >= 0, '1.5' = 1.5",
    async (db) => {
      const stored = await db.ledgers.insert(GOOD);
      expect([stored.total, stored.rate]).toEqual(['5', '1.50']);
      const big = await db.ledgers.insert({ ...GOOD, id: idAt(2), total: '9007199254740993' });
      expect(big.total).toBe('9007199254740993');
    },
  ),
  checkOver({ ledgers }, 'a row breaking a value rule is refused and not stored', async (db) => {
    expect(await outcome(() => db.ledgers.insert({ ...GOOD, total: '-1' }))).toEqual(REFUSED);
    expect(await outcome(() => db.ledgers.insert({ ...GOOD, rate: '1.6' }))).toEqual(REFUSED);
    expect(await db.ledgers.all()).toHaveLength(0);
  }),
  checkOver({ ledgers }, 'trimmed() strips spaces only, as btrim() does', async (db) => {
    expect(
      await outcome(async () => (await db.ledgers.insert({ ...GOOD, code: '  x ' })).code),
    ).toEqual({ ok: '  x ' });
    for (const [index, code] of ['\tx', 'x\n'].entries()) {
      expect(
        await outcome(() => db.ledgers.insert({ ...GOOD, id: idAt(index + 2), code })),
      ).toEqual(REFUSED);
    }
  }),
  checkOver({ ledgers }, 'int8 ends where Postgres ends it; numeric(2,2) holds 0.5', async (db) => {
    const top = await db.ledgers.insert({ ...GOOD, total: '9223372036854775807' });
    expect(top.total).toBe('9223372036854775807');
    const past = { ...GOOD, id: idAt(2), total: '9223372036854775808' };
    expect(await outcome(() => db.ledgers.insert(past))).toEqual(REFUSED);
    expect((await db.ledgers.insert({ ...GOOD, id: idAt(3), share: '0.5' })).share).toBe('0.50');
  }),
  checkOver({ ledgers }, 'url() refuses what is no url before any CHECK can', async (db) => {
    for (const href of ['  https://a.b', 'ht\ttps://a.b', 'https:/a.b']) {
      expect([href, await outcome(() => db.ledgers.insert({ ...GOOD, href }))]).toEqual([
        href,
        REFUSED,
      ]);
    }
  }),
  checkOver({ ranges }, 'a refused app-only rule leaves the row as it was', async (db) => {
    await db.ranges.insert({ id: ID, low: 1, high: 5 });
    expect(await outcome(() => db.ranges.update(ID, { low: 9 }))).toEqual(REFUSED);
    expect(await db.ranges.where({ id: ID }).one()).toEqual({ id: ID, low: 1, high: 5 });
  }),
  checkOver({ ranges }, 'a refused updateWhere leaves every matched row as it was', async (db) => {
    // The lower id takes `high: 20`, so it holds; the row after it does not. A driver writing row
    // by row stores the first before the second refuses — the half-written state this catches.
    await db.ranges.insert({ id: ID, low: 1, high: 20 });
    await db.ranges.insert({ id: idAt(2), low: 1, high: 5 });
    expect(await outcome(() => db.ranges.updateWhere({ low: 1 }, { low: 9 }))).toEqual(REFUSED);
    expect((await db.ranges.orderBy('high').all()).map((row) => row.low)).toEqual([1, 1]);
  }),
  checkOver({ ranges }, 'a write that holds still lands', async (db) => {
    await db.ranges.insert({ id: ID, low: 1, high: 5 });
    await db.ranges.update(ID, { low: 4 });
    expect(await db.ranges.updateWhere({ low: 4 }, { high: 9 })).toBe(1);
    expect(await db.ranges.where({ id: ID }).one()).toEqual({ id: ID, low: 4, high: 9 });
  }),
];

const malformedIds: readonly EntityDriverCheck[] = [
  checkOver(
    { priced },
    'a malformed uuid is refused before the store, by every write',
    async (_db, { driver }) => {
      const repo = driver.repo(priced);
      const bad = '00000000-0000-7000-8000-0000000000p0';
      expect(await outcome(() => repo.insert({ id: bad, price: null }))).toEqual(REFUSED);
      expect(await outcome(() => repo.insertAll([{ id: bad, price: null }]))).toEqual(REFUSED);
      expect(await repo.count({})).toBe(0);
    },
  ),
];

export const VALUE_CHECKS: readonly EntityDriverCheck[] = [
  ...jsonNull,
  ...moneyWrites,
  ...valueRules,
  ...malformedIds,
];
