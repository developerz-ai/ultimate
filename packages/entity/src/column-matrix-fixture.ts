// Every column kind an entity can declare, and every element kind `arrayOf()` accepts, in ONE
// entity with a corpus of adversarial rows — the matrix the two driver suites walk. Shared so the
// PGlite run (`column-matrix-parity.test.ts`, the `unit` step) and the `Bun.SQL` run
// (`column-matrix.live.test.ts`, the `live` step) answer the same question about the same rows.

import { expect, test } from 'bun:test';
import { type DbClient, generateMigration, raw, statementsOf } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import type { PlainDate } from '@ultimat3/time';
import { isRefusedElement } from './array-element';
import { boolean, integer, money, text, timestamp, url, uuid } from './columns';
import { arrayOf, bigint, bytes, date, decimal, json } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { COLUMN_KINDS } from './types';

const MOODS = ['sad', 'ok', 'happy'] as const;

/**
 * `<kind>s` is `arrayOf(<kind>)` and `<kind>Gaps` is the same array with nullable ELEMENTS — a SQL
 * NULL inside a row value, the one shape a driver's binary array reader has to carry a null bitmap
 * for. Every array column is nullable so one row can hold `null` for the whole column.
 */
export const matrix = entity('column_matrix_rows', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    mood: enumerated(MOODS),
    link: url().nullable(),
    count: integer(),
    flag: boolean(),
    at: timestamp(),
    rate: decimal({ precision: 18, scale: 8 }),
    day: date(),
    big: bigint(),
    data: json(t.object({ plan: t.string, seats: t.number })),
    blob: bytes().nullable(),
    price: money().nullable(),
    uuids: arrayOf(uuid()).nullable(),
    uuidGaps: arrayOf(uuid().nullable()).nullable(),
    texts: arrayOf(text()).nullable(),
    textGaps: arrayOf(text().nullable()).nullable(),
    moods: arrayOf(enumerated(MOODS)).nullable(),
    links: arrayOf(url()).nullable(),
    counts: arrayOf(integer()).nullable(),
    countGaps: arrayOf(integer().nullable()).nullable(),
    flags: arrayOf(boolean()).nullable(),
    flagGaps: arrayOf(boolean().nullable()).nullable(),
    ats: arrayOf(timestamp()).nullable(),
    atGaps: arrayOf(timestamp().nullable()).nullable(),
    rates: arrayOf(decimal({ precision: 18, scale: 8 })).nullable(),
    rateGaps: arrayOf(decimal().nullable()).nullable(),
    days: arrayOf(date()).nullable(),
    dayGaps: arrayOf(date().nullable()).nullable(),
    bigs: arrayOf(bigint()).nullable(),
    bigGaps: arrayOf(bigint().nullable()).nullable(),
  },
});

export type MatrixRow = typeof matrix.$row;
type MatrixWrite = Parameters<ReturnType<typeof matrixDb>['rows']['insert']>[0];

export const matrixDb = (driver: Driver) => database({ rows: matrix }, { driver });

const A = '01a12719-28e5-735e-b5bb-000000000001';
const B = '01a12719-28e5-735e-b5bb-000000000002';
const day = (value: string): PlainDate => value as PlainDate;

const SCALARS = {
  mood: 'ok',
  count: 7,
  flag: true,
  at: new Date('2026-01-02T03:04:05.123Z'),
  rate: '1.23456789',
  day: day('2026-03-14'),
  big: '9007199254740993',
  data: { plan: 'team', seats: 12 },
} as const;

/** The element text a Postgres array literal has to quote or escape, each one a single element. */
export const NASTY_TEXT = [
  'plain',
  'with,comma',
  'quote"inside',
  'back\\slash',
  '{braces}',
  '',
  ' padded ',
  'NULL',
  'null',
  'line\nbreak',
  'tab\there',
  'ünï©ode ✓',
  "single'quote",
] as const;

/** Named, so a failure says which row of the matrix it was. */
export const MATRIX_ROWS: Readonly<Record<string, MatrixWrite>> = Object.freeze({
  'every array holds two members': {
    ...SCALARS,
    label: 'full',
    link: 'https://example.com/a?b=c,d',
    blob: new Uint8Array([0, 255, 16]),
    price: { minor: 1999, currency: 'EUR' },
    uuids: [A, B],
    uuidGaps: [A, B],
    texts: ['alpha', 'beta'],
    textGaps: ['alpha', 'beta'],
    moods: ['sad', 'happy'],
    links: ['https://example.com/a,b', 'http://example.com/{c}'],
    counts: [1, -2147483648],
    countGaps: [2147483647, 0],
    flags: [true, false],
    flagGaps: [false, true],
    ats: [new Date('2026-01-02T03:04:05.123Z'), new Date('1999-12-31T23:59:59.999Z')],
    atGaps: [new Date('2026-06-01T00:00:00.000Z'), new Date(0)],
    rates: ['1.23456789', '-0.5'],
    rateGaps: ['12345678901234567890.123456789', '0'],
    days: [day('2026-03-14'), day('1970-01-01')],
    dayGaps: [day('2024-02-29'), day('2026-12-31')],
    bigs: ['9007199254740993', '-9223372036854775808'],
    bigGaps: ['9223372036854775807', '0'],
  },
  'every array holds one member': {
    ...SCALARS,
    label: 'single',
    uuids: [A],
    uuidGaps: [A],
    texts: ['only'],
    textGaps: ['only'],
    moods: ['ok'],
    links: ['https://example.com/'],
    counts: [42],
    countGaps: [42],
    flags: [true],
    flagGaps: [false],
    ats: [new Date('2026-01-02T03:04:05.123Z')],
    atGaps: [new Date('2026-01-02T03:04:05.123Z')],
    rates: ['1.5'],
    rateGaps: ['1.5'],
    days: [day('2026-03-14')],
    dayGaps: [day('2026-03-14')],
    bigs: ['1'],
    bigGaps: ['1'],
  },
  'every array is empty': {
    ...SCALARS,
    label: 'empty',
    uuids: [],
    uuidGaps: [],
    texts: [],
    textGaps: [],
    moods: [],
    links: [],
    counts: [],
    countGaps: [],
    flags: [],
    flagGaps: [],
    ats: [],
    atGaps: [],
    rates: [],
    rateGaps: [],
    days: [],
    dayGaps: [],
    bigs: [],
    bigGaps: [],
  },
  'every array column is null': {
    ...SCALARS,
    label: 'null columns',
    link: null,
    blob: null,
    price: null,
    uuids: null,
    uuidGaps: null,
    texts: null,
    textGaps: null,
    moods: null,
    links: null,
    counts: null,
    countGaps: null,
    flags: null,
    flagGaps: null,
    ats: null,
    atGaps: null,
    rates: null,
    rateGaps: null,
    days: null,
    dayGaps: null,
    bigs: null,
    bigGaps: null,
  },
  'a null sits between two members': {
    ...SCALARS,
    label: 'gaps',
    uuidGaps: [A, null, B],
    textGaps: ['a', null, 'NULL', ''],
    countGaps: [1, null, 3],
    flagGaps: [true, null, false],
    atGaps: [new Date('2026-01-02T03:04:05.123Z'), null],
    rateGaps: ['1.5', null, '2'],
    dayGaps: [day('2026-03-14'), null],
    bigGaps: ['9007199254740993', null],
  },
  'every member is null': {
    ...SCALARS,
    label: 'all gaps',
    uuidGaps: [null],
    textGaps: [null, null],
    countGaps: [null],
    flagGaps: [null],
    atGaps: [null],
    rateGaps: [null],
    dayGaps: [null],
    bigGaps: [null],
  },
  'text the array literal has to quote': {
    ...SCALARS,
    label: 'nasty',
    texts: [...NASTY_TEXT],
    textGaps: [...NASTY_TEXT, null],
  },
});

const DROP = `drop table if exists "${matrix.$table}" cascade`;

/** The matrix table, created from the entity's own migration — never hand-written DDL. */
export const createMatrixTable = async (client: DbClient): Promise<void> => {
  await client.execute(raw(DROP));
  const migration = generateMigration({
    entities: [matrix.$describe()],
    name: 'column matrix',
    now: new Date('2026-10-10T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
};

export const dropMatrixTable = async (client: DbClient): Promise<void> => {
  await client.execute(raw(DROP));
};

/**
 * One row through every read path that decodes: the `returning` of the insert, a keyed read (a
 * statement WITH a parameter), an unfiltered read, and the `returning` of an update. A driver may
 * decode a column differently per protocol — `Bun.SQL` reads `int4[]` as an `Array` on the simple
 * protocol and as an `Int32Array` on the extended one (measured, 1.4.2) — so one path is not all.
 */
export const roundTrip = async (driver: Driver, write: MatrixWrite) => {
  const db = matrixDb(driver);
  const inserted = await db.rows.insert(write);
  const keyed = await db.rows.where({ id: inserted.id }).one();
  const listed = (await db.rows.where({}).all()).find((row) => row.id === inserted.id) ?? null;
  const updated = await db.rows.update(inserted.id, { label: `${write.label} again` });
  const detach = <R extends { readonly label?: string } | null>(row: R) =>
    row === null ? null : { ...row, label: write.label };
  return { inserted, keyed, listed, updated: detach(updated) };
};

/** The array columns, read off the declaration so a column added above is a column tested below. */
const ARRAY_COLUMNS = Object.entries(matrix.$columns)
  .filter(([, column]) => column.$meta.kind === 'array')
  .map(([property]) => property);

/**
 * The WRITE direction: a JS array bound as the operand of `@>` and `&&` against every array type.
 * A literal that reads back correctly can still be one the server refuses to COMPARE — an untyped
 * parameter takes the column's type, and `{"2026-01-02T03:04:05.123Z"}` has to parse as a
 * `timestamptz[]` there. Asked of both drivers, because memory answering alone proves nothing.
 */
const matches = async (driver: Driver, id: string, column: string, member: unknown) => {
  const repo = driver.repo(matrix);
  const found = async (op: 'contains' | 'overlaps') =>
    (
      await repo.findMany({
        where: [
          { column: 'id', op: 'eq', value: id },
          { column, op, value: [member] },
        ],
        orderBy: [{ column: 'id', direction: 'asc' }],
        limit: 5,
      })
    ).rows.length;
  return { contains: await found('contains'), overlaps: await found('overlaps') };
};

/**
 * The cases both driver suites run. `open` is called per case, after the suite's `beforeAll` has
 * installed its client, so the driver under test is whichever one that suite stands on.
 */
export const columnMatrixCases = (open: () => Driver): void => {
  // The ratchet: a column kind added to `COLUMN_KINDS` with no column above is red here, so the
  // next kind cannot ship having met only the driver its author happened to run. `char` has no
  // constructor of its own — it is the currency half of `money()`.
  test('the matrix declares every column kind, and an array of every element kind', () => {
    const columns = Object.values(matrix.$columns).map((column) => column.$meta);
    const declared = new Set<string>(columns.map((meta) => meta.kind));
    const elements = new Set<string>(columns.flatMap((meta) => meta.element?.$meta.kind ?? []));
    const scalar = COLUMN_KINDS.filter((kind) => kind !== 'char');
    expect(scalar.filter((kind) => !declared.has(kind))).toEqual([]);
    expect(scalar.filter((kind) => !isRefusedElement(kind) && !elements.has(kind))).toEqual([]);
  });

  test('the corpus writes every column the entity declares', () => {
    const written = new Set(Object.values(MATRIX_ROWS).flatMap((row) => Object.keys(row)));
    const unwritten = Object.keys(matrix.$columns).filter(
      (name) => name !== 'id' && !written.has(name),
    );
    expect(unwritten).toEqual([]);
  });

  for (const [name, write] of Object.entries(MATRIX_ROWS)) {
    test(`${name}: the driver reads back what memory reads back`, async () => {
      const id = crypto.randomUUID();
      const memory = await roundTrip(memoryDriver(), { ...write, id });
      const real = await roundTrip(open(), { ...write, id });
      expect(real.inserted).toEqual(memory.inserted);
      expect(real.keyed).toEqual(memory.keyed);
      expect(real.listed).toEqual(memory.listed);
      expect(real.updated).toEqual(memory.updated);
      // Memory is not merely agreeing with itself: every array read back IS a JS array, of the
      // members that were written — the one claim `toEqual` between two wrong answers cannot make.
      const source = write as Readonly<Record<string, unknown>>;
      const keyed = (real.keyed ?? {}) as Readonly<Record<string, unknown>>;
      for (const column of ARRAY_COLUMNS) {
        const wrote = new Map(Object.entries(source)).get(column) ?? null;
        const read = new Map(Object.entries(keyed)).get(column);
        if (wrote === null) expect(read).toBeNull();
        else expect(Array.isArray(read) && read.length === (wrote as unknown[]).length).toBe(true);
      }
    });
  }

  test('a bound array is an operand every array type compares against', async () => {
    const write = MATRIX_ROWS['every array holds two members'];
    if (write === undefined) return expect.unreachable('the two-member row left the corpus');
    const id = crypto.randomUUID();
    const memory = memoryDriver();
    const real = open();
    await matrixDb(memory).rows.insert({ ...write, id });
    await matrixDb(real).rows.insert({ ...write, id });
    const source = new Map(Object.entries(write as Readonly<Record<string, unknown>>));
    for (const column of ARRAY_COLUMNS) {
      const [member] = source.get(column) as readonly unknown[];
      const answer = await matches(real, id, column, member);
      expect({ column, ...answer }).toEqual({ column, contains: 1, overlaps: 1 });
      expect({ column, ...(await matches(memory, id, column, member)) }).toEqual({
        column,
        ...answer,
      });
    }
  });
};
