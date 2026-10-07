// Single responsibility: `where` and `order by` on a decimal-text, a `uuid` and a mixed-number
// column answer the same rows in both drivers — `memoryDriver()` and `postgresDriver()` over a real
// embedded Postgres (PGlite). `memory-match.ts` is the ONE statement of how a column compares, and
// `@ultimat3/query`'s matcher calls it too, so a row it gets wrong is wrong on three surfaces.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { compareByKind, sameValueOfKind } from './memory-match';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import type { ColumnKind } from './types';

const PGLITE_BOOT_MS = 30_000;

const ledger = entity('cp_ledger', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 20 }),
    total: bigint(),
    rate: decimal({ precision: 12, scale: 2 }),
    loose: decimal(),
    seats: integer(),
  },
});

const ENTITIES = { ledger };
type Db = ReturnType<typeof database<typeof ENTITIES>>;
const client = pgliteClient();

/** Hex LETTERS, so an id has a case to change; text order and numeric order differ on every pair. */
const idAt = (hex: string): string => `00000000-0000-7000-8000-0000000000${hex}`;
const SEEDED = [
  { id: idAt('0a'), label: 'ten', total: '10', rate: '2.50', loose: '0.1', seats: 10 },
  { id: idAt('0b'), label: 'nine', total: '9', rate: '10.00', loose: '0', seats: 9 },
  {
    id: idAt('1a'),
    label: 'big',
    total: '9007199254740993',
    rate: '-1.50',
    loose: '-2.25',
    seats: 2,
  },
] as const;

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [ledger.$describe()],
    name: 'compare parity',
    now: new Date('2026-10-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "cp_ledger"'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

/** One body against both drivers, seeded alike; memory's answer first. */
const both = async <T>(body: (db: Db) => Promise<T>): Promise<readonly [T, T]> => {
  const run = async (db: Db): Promise<T> => {
    for (const row of SEEDED) await db.ledger.insert({ ...row });
    return body(db);
  };
  return [
    await run(database(ENTITIES, { driver: memoryDriver() })),
    await run(database(ENTITIES, { driver: postgresDriver() })),
  ] as const;
};

type Column = 'id' | 'total' | 'rate' | 'loose' | 'seats';
type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';

const labels = async (db: Db, column: Column, op: Op, value: unknown): Promise<string[]> =>
  (await db.ledger.andWhere(column, op, value).all()).map((row) => row.label).sort();

describe('a predicate on a decimal-text column compares by VALUE in both drivers', () => {
  test.each([
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
  ] as const)('%s %s %p', async (column, op, value, expected) => {
    const [memory, pg] = await both((db) => labels(db, column, op, value));
    expect(pg).toEqual([...expected]);
    expect(memory).toEqual(pg);
  });

  test.each([
    ['total', 'asc', ['nine', 'ten', 'big']],
    ['rate', 'desc', ['nine', 'ten', 'big']],
    ['loose', 'asc', ['big', 'nine', 'ten']],
  ] as const)('order by %s %s', async (column, direction, expected) => {
    const [memory, pg] = await both(async (db) =>
      (await db.ledger.orderBy(column, direction).all()).map((row) => row.label),
    );
    expect(pg).toEqual([...expected]);
    expect(memory).toEqual(pg);
  });
});

describe('a uuid is a value, whatever case the operand is written in', () => {
  test.each([
    ['eq', idAt('0A'), ['ten']],
    ['gt', idAt('0A'), ['big', 'nine']],
    ['gte', idAt('0B'), ['big', 'nine']],
    ['lt', idAt('0B'), ['ten']],
    ['lte', idAt('1A'), ['big', 'nine', 'ten']],
  ] as const)('id %s %p', async (op, value, expected) => {
    const [memory, pg] = await both((db) => labels(db, 'id', op, value));
    expect(pg).toEqual([...expected]);
    expect(memory).toEqual(pg);
  });
});

describe('the rule itself, on the pairs no stored row can hold', () => {
  test.each<[ColumnKind | undefined, unknown, unknown, number]>([
    // One driver's `int8` beside a literal, with no declared kind at all.
    [undefined, 2, 10n, -1],
    [undefined, 10n, 2, 1],
    [undefined, 2, 2n, 0],
    [undefined, 9007199254740993n, 9007199254740992, 1],
    [undefined, 1.5, 2n, -1],
    // The form a cursor revives, against the row's own text.
    ['bigint', 9n, '10', -1],
    ['bigint', 1e21, '999999999999999999999', 1],
    ['numeric', '-0.00', '0', 0],
    ['uuid', idAt('0A'), idAt('0a'), 0],
    ['uuid', idAt('0B'), idAt('0a'), 1],
    // Digits in a TEXT column are characters, and so are digits with no kind.
    ['text', '10', '9', -1],
    [undefined, '10', '9', -1],
  ])('%p: %p against %p orders %p, and equality agrees', (kind, left, right, order) => {
    expect(compareByKind(kind, left, right)).toBe(order);
    expect(compareByKind(kind, right, left)).toBe(-order || 0);
    expect(sameValueOfKind(kind, left, right)).toBe(order === 0);
  });

  test('NaN equals nothing, itself included', () => {
    expect(sameValueOfKind('integer', Number.NaN, Number.NaN)).toBe(false);
  });
});
