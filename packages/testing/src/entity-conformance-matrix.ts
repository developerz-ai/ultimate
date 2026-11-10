// Entity conformance · every column kind and every `arrayOf()` element kind round-trips: through
// the insert's answer, a keyed read, a listed read and an update's answer, each equal to what the
// reference `memoryDriver()` reads back; a bound array compares against every array type; and a
// unique decimal is one value under two spellings. Lifted from `entity/src/column-matrix-parity`.

import { expect } from 'bun:test';
import type { Driver } from '@ultimat3/entity';
import {
  arrayOf,
  bigint,
  boolean,
  bytes,
  COLUMN_KINDS,
  database,
  date,
  decimal,
  entity,
  enumerated,
  integer,
  json,
  memoryDriver,
  money,
  t,
  text,
  timestamp,
  url,
  uuid,
} from '@ultimat3/entity';
import type { PlainDate } from '@ultimat3/time';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const MOODS = ['sad', 'ok', 'happy'] as const;

/**
 * `<kind>s` is `arrayOf(<kind>)` and `<kind>Gaps` is the same array with nullable ELEMENTS — a SQL
 * NULL inside a row value, the one shape a driver's binary array reader has to carry a null bitmap
 * for. Every array column is nullable so one row can hold `null` for the whole column.
 */
const matrix = remember(
  entity('ec_m_rows', {
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
  }),
);

type MatrixWrite = Parameters<ReturnType<typeof matrixDb>['rows']['insert']>[0];

const matrixDb = (driver: Driver) => database({ rows: matrix }, { driver });

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
const NASTY_TEXT = [
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
const MATRIX_ROWS: Readonly<Record<string, MatrixWrite>> = Object.freeze({
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

const roundTrip = async (driver: Driver, write: MatrixWrite) => {
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

/** Fixed per row so a SQL subject and the memory reference write the same key. */
const idFor = (index: number): string =>
  `01a12719-28e5-735e-b5bb-0000000001${String(index).padStart(2, '0')}`;

/** The ratchet: a kind added to `COLUMN_KINDS` with no column here is red, for every driver. */
const declaresEveryKind: EntityDriverCheck = checkOver(
  { matrix },
  'column matrix · declares every column kind',
  async () => {
    const declared = new Set<string>(
      Object.values(matrix.$columns).map((column) => column.$meta.kind),
    );
    // `char` has no constructor of its own: it is the currency half of `money()`.
    expect(COLUMN_KINDS.filter((kind) => kind !== 'char' && !declared.has(kind))).toEqual([]);
  },
);

const roundTrips: readonly EntityDriverCheck[] = Object.entries(MATRIX_ROWS).map(
  ([name, write], index) =>
    checkOver(
      { matrix },
      `column matrix · ${name}: reads back what memory reads back`,
      async (_db, { driver }) => {
        const id = idFor(index);
        const reference = await roundTrip(memoryDriver(), { ...write, id });
        const real = await roundTrip(driver, { ...write, id });
        expect(real).toEqual(reference);
        // Memory is not merely agreeing with itself: every array read back IS a JS array of the
        // members written — the one claim `toEqual` between two wrong answers cannot make.
        const source = new Map(Object.entries(write as Readonly<Record<string, unknown>>));
        const keyed = new Map(
          Object.entries((real.keyed ?? {}) as Readonly<Record<string, unknown>>),
        );
        for (const column of ARRAY_COLUMNS) {
          const wrote = source.get(column) ?? null;
          const read = keyed.get(column);
          const shape =
            wrote === null
              ? read === null
              : Array.isArray(read) && read.length === (wrote as unknown[]).length;
          expect({ column, shape }).toEqual({ column, shape: true });
        }
      },
    ),
);

const operand: EntityDriverCheck = checkOver(
  { matrix },
  'column matrix · a bound array is an operand every array type compares against',
  async (_db, { driver }) => {
    const write = MATRIX_ROWS['every array holds two members'];
    if (write === undefined) return expect.unreachable('the two-member row left the corpus');
    const id = idFor(99);
    await matrixDb(driver).rows.insert({ ...write, id });
    const source = new Map(Object.entries(write as Readonly<Record<string, unknown>>));
    for (const column of ARRAY_COLUMNS) {
      const [member] = source.get(column) as readonly unknown[];
      expect({ column, ...(await matches(driver, id, column, member)) }).toEqual({
        column,
        contains: 1,
        overlaps: 1,
      });
    }
  },
);

const amounts = remember(
  entity('ec_m_amounts', {
    columns: { id: uuid().primaryKey(), d: decimal().unique(), label: text({ max: 8 }).nullable() },
  }),
);
const bounded = remember(
  entity('ec_m_bounded', {
    columns: { id: uuid().primaryKey(), d: decimal({ precision: 10, scale: 2 }).unique() },
  }),
);
const UNIQUE = 'X_DB_UNIQUE_VIOLATION';
const SET = { amounts, bounded };
const UPDATE = { onConflict: ['d'], onMatch: 'update' } as const;

const uniqueDecimals: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'a unique decimal is one value: 2.5 and 2.50 collide, 2.51 does not',
    async (db) => {
      await db.amounts.insert({ d: '2.5' });
      expect(await codeOf(() => db.amounts.insert({ d: '2.50' }))).toBe(UNIQUE);
      expect(await db.amounts.where({ d: '2.500' }).all()).toHaveLength(1);
      expect(await codeOf(() => db.amounts.insert({ d: '2.51' }))).toBe('resolved');
      await db.bounded.insert({ d: '2.5' });
      expect(await codeOf(() => db.bounded.insert({ d: '2.50' }))).toBe(UNIQUE);
    },
  ),
  checkOver(
    SET,
    'an upsert on a unique decimal lands on the one row; a batch spelling it twice is refused whole',
    async (db) => {
      const pair = [
        { d: '2.5', label: 'a' },
        { d: '2.50', label: 'b' },
      ];
      expect(await codeOf(() => db.amounts.upsertAll(pair, UPDATE))).not.toBe('resolved');
      expect(await db.amounts.all()).toHaveLength(0);
      await db.amounts.upsertAll([{ d: '2.5', label: 'a' }], UPDATE);
      await db.amounts.upsertAll([{ d: '2.50', label: 'b' }], UPDATE);
      expect((await db.amounts.all()).map((row) => row.label)).toEqual(['b']);
    },
    ['upsert'],
  ),
];

export const MATRIX_CHECKS: readonly EntityDriverCheck[] = [
  declaresEveryKind,
  ...roundTrips,
  operand,
  ...uniqueDecimals,
];
