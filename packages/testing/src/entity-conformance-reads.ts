// Entity conformance · what a READ answers: a predicate compares by value (decimal text, a uuid in
// any case, an instant written as text), text orders by code point, an unknown operator is one
// refusal, `select` projects, and LIKE / has-key / array operators read the rows Postgres reads.
// Lifted from `entity/src/{compare,select,instant-text,write}-parity.test.ts`.

import { expect } from 'bun:test';
import { bigint, decimal, entity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt } from './entity-conformance-support';
import { conformanceDocs as docs } from './entity-conformance-writes';
import type { EntityDriverCheck } from './entity-driver-conformance';

const ledger = remember(
  entity('ec_r_ledger', {
    columns: {
      id: uuid().primaryKey(),
      label: text({ max: 20 }),
      total: bigint(),
      rate: decimal({ precision: 12, scale: 2 }),
      loose: decimal(),
      seats: integer(),
    },
  }),
);

const notes = remember(
  entity('ec_r_notes', {
    columns: { id: uuid().primaryKey(), title: text(), body: text(), rank: integer() },
  }),
);

const events = remember(
  entity('ec_r_events', {
    columns: { id: uuid().primaryKey(), label: text({ max: 20 }), createdAt: timestamp() },
  }),
);

/** Hex LETTERS, so an id has a case to change; text order and numeric order differ on every pair. */
const hexId = (hex: string): string => `00000000-0000-7000-8000-0000000000${hex}`;
const SEEDED = [
  { id: hexId('0a'), label: 'ten', total: '10', rate: '2.50', loose: '0.1', seats: 10 },
  { id: hexId('0b'), label: 'nine', total: '9', rate: '10.00', loose: '0', seats: 9 },
  {
    id: hexId('1a'),
    label: 'big',
    total: '9007199254740993',
    rate: '-1.50',
    loose: '-2.25',
    seats: 2,
  },
] as const;

const UNKNOWN = 'X_ENTITY_OPERATOR_UNKNOWN';

type Column = 'id' | 'total' | 'rate' | 'loose' | 'seats';
type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';

const PREDICATES: readonly (readonly [Column, Op, unknown, readonly string[]])[] = [
  ['total', 'eq', 10, ['ten']],
  ['total', 'eq', '10', ['ten']],
  ['total', 'neq', 10, ['big', 'nine']],
  ['total', 'in', [9, '10'], ['nine', 'ten']],
  ['total', 'gt', 9, ['big', 'ten']],
  ['total', 'lte', '10', ['nine', 'ten']],
  ['rate', 'eq', '2.5', ['ten']],
  ['rate', 'eq', 2.5, ['ten']],
  ['rate', 'eq', '2.500', ['ten']],
  ['rate', 'neq', '2.5', ['big', 'nine']],
  ['rate', 'in', ['10', '-1.5'], ['big', 'nine']],
  ['rate', 'lt', '10', ['big', 'ten']],
  ['loose', 'eq', '0.10', ['ten']],
  ['loose', 'eq', '-0.00', ['nine']],
  ['loose', 'eq', 0, ['nine']],
  ['id', 'eq', hexId('0A'), ['ten']],
  ['id', 'gt', hexId('0A'), ['big', 'nine']],
  ['id', 'gte', hexId('0B'), ['big', 'nine']],
  ['id', 'lt', hexId('0B'), ['ten']],
  ['id', 'lte', hexId('1A'), ['big', 'nine', 'ten']],
];

const comparisons: readonly EntityDriverCheck[] = [
  checkOver({ ledger }, 'decimal text and a uuid in any case compare by value', async (db) => {
    for (const row of SEEDED) await db.ledger.insert({ ...row });
    for (const [column, op, value, expected] of PREDICATES) {
      const labels = (await db.ledger.andWhere(column, op, value).all()).map((row) => row.label);
      expect([column, op, value, labels.sort()]).toEqual([column, op, value, [...expected]]);
    }
  }),
  checkOver({ ledger }, 'order by a decimal-text column orders by value', async (db) => {
    for (const row of SEEDED) await db.ledger.insert({ ...row });
    const order = async (column: Column, direction: 'asc' | 'desc') =>
      (await db.ledger.orderBy(column, direction).all()).map((row) => row.label);
    expect(await order('total', 'asc')).toEqual(['nine', 'ten', 'big']);
    expect(await order('rate', 'desc')).toEqual(['nine', 'ten', 'big']);
    expect(await order('loose', 'asc')).toEqual(['big', 'nine', 'ten']);
  }),
  checkOver(
    { ledger },
    'an operator outside the vocabulary is X_ENTITY_OPERATOR_UNKNOWN',
    async (db, { driver }) => {
      // On an empty table first: the refusal is the call's, never the rows'.
      const empty = [{ column: 'seats', op: '>' as Op, value: 5 }];
      expect(await codeOf(() => driver.repo(ledger).findMany({ where: empty }))).toBe(UNKNOWN);
      for (const row of SEEDED) await db.ledger.insert({ ...row });
      for (const op of ['>', '<>', 'GTE']) {
        // Both doors: the typed chain, and the repository a hand-written caller reaches.
        const where = [{ column: 'seats', op: op as Op, value: 5 }];
        const chain = await codeOf(() => db.ledger.andWhere('seats', op as Op, 5).all());
        const repo = await codeOf(() => driver.repo(ledger).findMany({ where }));
        expect([op, chain, repo]).toEqual([op, UNKNOWN, UNKNOWN]);
      }
    },
  ),
];

const projection: readonly EntityDriverCheck[] = [
  checkOver(
    { notes },
    'select answers the asked columns and the primary key, nothing else',
    async (_db, { driver }) => {
      const repo = driver.repo(notes);
      for (const n of [1, 2, 3])
        await repo.insert({ id: idAt(n), title: `t${n}`, body: `b${n}`, rank: 4 - n });
      const { rows } = await repo.findMany({ select: ['title'] });
      expect(rows.map((row) => Object.keys(row).sort())).toEqual([
        ['id', 'title'],
        ['id', 'title'],
        ['id', 'title'],
      ]);
    },
  ),
  checkOver(
    { notes },
    'a selected page carries its sort key, so the cursor can be minted',
    async (_db, { driver }) => {
      const repo = driver.repo(notes);
      for (const n of [1, 2, 3])
        await repo.insert({ id: idAt(n), title: `t${n}`, body: `b${n}`, rank: 4 - n });
      const orderBy = [{ column: 'rank', direction: 'asc' as const }];
      const first = await repo.findMany({ select: ['title'], orderBy, limit: 2 });
      const cursor = first.nextCursor === null ? {} : { cursor: first.nextCursor };
      const next = await repo.findMany({ select: ['title'], orderBy, limit: 2, ...cursor });
      const rows = [...first.rows, ...next.rows];
      expect(rows.map((row) => row.title)).toEqual(['t3', 't2', 't1']);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'rank', 'title']);
    },
  ),
];

const at = (second: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
const newestFirst = [{ column: 'createdAt', direction: 'desc' as const }];

const instants: readonly EntityDriverCheck[] = [
  checkOver(
    { events },
    'an ISO instant as text compares as the instant it names',
    async (_db, { driver }) => {
      const repo = driver.repo(events);
      for (const n of [1, 2, 3, 4, 5])
        await repo.insert({ id: idAt(n), label: `e${n}`, createdAt: at(n) });
      const where = async (op: Op, value: string) =>
        (
          await repo.findMany({ where: [{ column: 'createdAt', op, value }], orderBy: newestFirst })
        ).rows.map((row) => row.label);
      expect(await where('eq', '2026-01-01T00:00:03.000Z')).toEqual(['e3']);
      expect(await where('eq', '2026-01-01T01:00:03+01:00')).toEqual(['e3']);
      expect(await where('neq', '2026-01-01T00:00:03Z')).toEqual(['e5', 'e4', 'e2', 'e1']);
      expect(await where('gte', '2026-01-01T00:00:04Z')).toEqual(['e5', 'e4']);
      expect(await where('gt', '2026-01-01T00:00:04Z')).toEqual(['e5']);
      expect(await where('lte', '2026-01-01T00:00:02Z')).toEqual(['e2', 'e1']);
    },
  ),
  checkOver(
    { events },
    'page two of a hand-kept keyset over an instant is the older rows',
    async (_db, { driver }) => {
      const repo = driver.repo(events);
      for (const n of [1, 2, 3, 4, 5])
        await repo.insert({ id: idAt(n), label: `e${n}`, createdAt: at(n) });
      const first = await repo.findMany({ orderBy: newestFirst, limit: 2 });
      expect(first.rows.map((row) => row.label)).toEqual(['e5', 'e4']);
      const after = first.rows.at(-1)?.createdAt.toISOString();
      const second = await repo.findMany({
        where: [{ column: 'createdAt', op: 'lt', value: after }],
        orderBy: newestFirst,
        limit: 2,
      });
      expect(second.rows.map((row) => row.label)).toEqual(['e3', 'e2']);
    },
  ),
];

type DocOp = 'like' | 'has-key' | 'contains' | 'contained-by' | 'overlaps';

const operators: readonly EntityDriverCheck[] = [
  checkOver({ docs }, 'LIKE counts characters: _ is one, astral or not', async (db) => {
    for (const [index, slug] of ['a', 'b', 'c', '😀', 'ab'].entries()) {
      await db.docs.insert({ id: idAt(index + 1), slug });
    }
    const slugs = async (value: string) =>
      (await db.docs.andWhere('slug', 'like', value).all()).map((row) => row.slug).sort();
    expect([await slugs('_'), await slugs('%_%_%')]).toEqual([['a', 'b', 'c', '😀'], ['ab']]);
  }),
  checkOver(
    { docs },
    'has-key takes a STRING key; any other operand matches no row',
    async (db) => {
      await db.docs.insert({ id: idAt(1), slug: 'digit', data: { '1': 'x' } });
      await db.docs.insert({ id: idAt(2), slug: 'word', data: { a: 'x', null: 'y' } });
      const answers: (readonly string[])[] = [];
      for (const key of ['1', 1, ['a'], null, undefined, true]) {
        answers.push((await db.docs.andWhere('data', 'has-key', key).all()).map((row) => row.slug));
      }
      expect(answers).toEqual([['digit'], [], [], [], [], []]);
    },
  ),
  checkOver(
    { docs },
    'a NULL array element matches nothing, on either side of @>, <@ and &&',
    async (db) => {
      await db.docs.insert({ id: idAt(1), slug: 'holed', marks: ['red', null] });
      await db.docs.insert({ id: idAt(2), slug: 'whole', marks: ['red'] });
      const slugs = async (op: DocOp, value: unknown) =>
        (await db.docs.andWhere('marks', op, value).all()).map((row) => row.slug).sort();
      expect([
        await slugs('contains', [null]),
        await slugs('contains', ['red', null]),
        await slugs('overlaps', [null]),
        await slugs('overlaps', [null, 'red']),
        await slugs('contained-by', ['red', null]),
      ]).toEqual([[], [], [], ['holed', 'whole'], ['whole']]);
    },
  ),
];

export const READ_CHECKS: readonly EntityDriverCheck[] = [
  ...comparisons,
  ...projection,
  ...instants,
  ...operators,
];
