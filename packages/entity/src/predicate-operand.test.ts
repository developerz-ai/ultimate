// One predicate, asked of BOTH drivers on the same rows: the in-memory store and Postgres (PGlite).
// Each case is an operand whose meaning depended on which driver read it — a zoneless text against
// an instant, a `Date` against a calendar date, a whole list against an array, a fraction against an
// integer. Either both drivers answer the same rows or both refuse with the same code.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  raw,
  statementsOf,
} from '@ultimat3/db';
import { plainDate } from '@ultimat3/time';
import { integer, text, timestamp, uuid } from './columns';
import { arrayOf, bigint, date } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import type { Predicate } from './tenancy';

const rows = entity('predicate_operand_rows', {
  columns: {
    id: uuid().primaryKey(),
    at: timestamp(),
    day: date(),
    tags: arrayOf(text()),
    n: integer(),
    big: bigint(),
  },
});

type Row = typeof rows.$row;

const idAt = (index: number): string => `00000000-0000-7000-8000-00000000000${String(index)}`;

const SEED = [
  { at: new Date('2026-01-01T00:00:00Z'), day: '2026-01-01', tags: ['a', 'b'], n: 1, big: '10' },
  { at: new Date('2025-01-01T00:00:00Z'), day: '2025-12-31', tags: [], n: 2, big: '9' },
  { at: new Date('2026-06-01T00:00:00Z'), day: '2026-02-01', tags: ['c'], n: 3, big: '-3' },
].map((row) => ({ ...row, day: plainDate(row.day) }));

let pglite: PgliteClient;
let memory: Repo<Row>;
let postgres: Repo<Row>;

beforeAll(async () => {
  pglite = pgliteClient();
  const migration = generateMigration({
    entities: [rows.$describe()],
    name: 'predicate operand parity',
    now: new Date('2026-11-17T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await pglite.execute(raw(statement));
  memory = memoryRepo(rows);
  postgres = postgresRepo(rows, { client: pglite });
  for (const repo of [memory, postgres]) {
    for (const [index, row] of SEED.entries()) {
      await repo.insert({ id: idAt(index), ...row });
    }
  }
}, 30_000);

afterAll(() => {
  clearRegistry();
});

afterAll(async () => {
  await pglite.close();
});

/** The seed indexes a predicate answers, or the code it is refused with. */
const answer = async (repo: Repo<Row>, predicate: Predicate): Promise<unknown> => {
  try {
    const found = await repo.findMany({
      where: [predicate],
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
    return found.rows.map((row) => Number(row.id.slice(-1)));
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
};

const both = async (predicate: Predicate): Promise<readonly unknown[]> => [
  await answer(memory, predicate),
  await answer(postgres, predicate),
];

const REFUSED = ['X_INVARIANT_VIOLATED', 'X_INVARIANT_VIOLATED'];

describe('timestamp(): an operand is one instant in both drivers', () => {
  // Zoneless ISO text is read as UTC: never the session `TimeZone` on Postgres, never a `Date`'s
  // text compared to the operand's in memory (which matched every row).
  test.each([
    ['gt', '2026-01-01', '2026-01-01T00:00:00Z'],
    ['lt', '2026-01-01T10:00', '2026-01-01T10:00:00Z'],
    ['eq', '2026-01-01T00:00:00', '2026-01-01T00:00:00Z'],
  ] as const)('%s %p is the UTC instant %p, the same rows in both', async (op, zoneless, utc) => {
    const answered = await both({ column: 'at', op, value: zoneless });
    expect(answered).toEqual(await both({ column: 'at', op, value: utc }));
    expect(answered[0]).toEqual(answered[1]);
  });

  test('a zoneless text inside an `in` list is read the same way', async () => {
    expect(await both({ column: 'at', op: 'in', value: ['2026-01-01'] })).toEqual(
      await both({ column: 'at', op: 'in', value: ['2026-01-01T00:00:00Z'] }),
    );
  });

  test('epoch milliseconds are refused by both drivers', async () => {
    expect(await both({ column: 'at', op: 'gte', value: 1_767_225_600_000 })).toEqual(REFUSED);
  });

  test('an instant with its zone still answers, the same rows in both', async () => {
    expect(await both({ column: 'at', op: 'gt', value: '2025-06-01T00:00:00Z' })).toEqual([
      [0, 2],
      [0, 2],
    ]);
    expect(await both({ column: 'at', op: 'eq', value: '2026-01-01T01:00:00+01:00' })).toEqual([
      [0],
      [0],
    ]);
  });
});

describe('date(): a Date operand is the calendar date it names in UTC', () => {
  test.each([
    ['lt', new Date('2026-01-02T00:00:00Z'), [0, 1]],
    ['eq', new Date('2026-01-01T00:00:00Z'), [0]],
    ['gte', new Date('2026-01-01T23:59:59Z'), [0, 2]],
    ['in', [new Date('2025-12-31T00:00:00Z')], [1]],
  ] as const)('%s %p', async (op, value, expected) => {
    expect(await both({ column: 'day', op, value })).toEqual([expected, expected]);
  });

  test('an Invalid Date is refused by both drivers', async () => {
    expect(await both({ column: 'day', op: 'eq', value: new Date(Number.NaN) })).toEqual(REFUSED);
  });
});

describe('arrayOf(): equality compares element by element', () => {
  test.each([
    [['a', 'b'], [0]],
    [[], [1]],
    [['b', 'a'], []],
  ] as const)('eq %p', async (value, expected) => {
    expect(await both({ column: 'tags', op: 'eq', value: [...value] })).toEqual([
      expected,
      expected,
    ]);
  });

  test('neq is its complement', async () => {
    expect(await both({ column: 'tags', op: 'neq', value: ['c'] })).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });
});

describe('integer() and bigint(): a non-integer operand is refused by both drivers', () => {
  test.each([
    ['n', 'lt', 1.5],
    ['n', 'eq', 2.5],
    ['n', 'gte', '1.5'],
    ['n', 'in', [1, 1.5]],
    ['big', 'gt', 9.5],
    ['big', 'gte', '1e1'],
    ['n', 'like', '1%'],
    ['big', 'like', '1%'],
  ] as const)('%s %s %p', async (column, op, value) => {
    expect(await both({ column, op, value })).toEqual(REFUSED);
  });

  test.each([
    ['n', 'lt', 2, [0]],
    ['n', 'eq', '002', [1]],
    ['big', 'gt', 9, [0]],
    ['big', 'lte', '9', [1, 2]],
    ['big', 'eq', 10n, [0]],
  ] as const)('%s %s %p still answers', async (column, op, value, expected) => {
    expect(await both({ column, op, value })).toEqual([expected, expected]);
  });
});
