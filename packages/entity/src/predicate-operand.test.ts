// One predicate, asked of BOTH drivers on the same rows: the in-memory store and Postgres (PGlite).
// Each case is an operand whose meaning depended on which driver read it — a zoneless text against
// an instant, a `Date` against a calendar date, a whole list against an array, a fraction against an
// integer. Either both drivers answer the same rows or both refuse with the same code.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  raw,
  statementsOf,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { plainDate } from '@ultimat3/time';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import { arrayOf, bigint, date, decimal, json } from './columns-data';
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
    flag: boolean(),
    label: text({ max: 20 }),
    ref: uuid().nullable(),
    data: json(t.object({ k: t.string })),
    price: money(),
    ints: arrayOf(integer()),
    amount: decimal({ precision: 4, scale: 2 }),
    payload: json(t.object({ ok: t.boolean })),
  },
});

type Row = typeof rows.$row;

const idAt = (index: number): string => `00000000-0000-7000-8000-00000000000${String(index)}`;

const SEED = [
  { at: new Date('2026-01-01T00:00:00Z'), day: '2026-01-01', tags: ['a', 'b'], n: 1, big: '10' },
  { at: new Date('2025-01-01T00:00:00Z'), day: '2025-12-31', tags: [], n: 2, big: '9' },
  { at: new Date('2026-06-01T00:00:00Z'), day: '2026-02-01', tags: ['c'], n: 3, big: '-3' },
].map((row, index) => ({
  ...row,
  day: plainDate(row.day),
  flag: index !== 1,
  label: `a${String(index)}`,
  ref: index === 1 ? null : idAt(7 + index),
  data: { k: 'v' },
  price: { minor: 3_000_000_000, currency: 'USD' },
  ints: [1, 2],
  amount: '1.25',
  payload: { ok: true },
}));

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

describe('uuid(): an operand that is no uuid equals no row, in both drivers', () => {
  // Postgres answered `22P02` — a 500 — for the id a URL carries; memory answered "no such row".
  test('a malformed uuid operand answers the same on memory and PGlite', async () => {
    expect(await both({ column: 'id', op: 'eq', value: 'nope' })).toEqual([[], []]);
    expect(await both({ column: 'id', op: 'eq', value: 5 })).toEqual([[], []]);
    expect(await both({ column: 'id', op: 'eq', value: ` ${idAt(0)}` })).toEqual([[], []]);
    expect(await both({ column: 'id', op: 'in', value: ['nope', idAt(1), 7] })).toEqual([[1], [1]]);
    expect(await both({ column: 'id', op: 'in', value: ['nope'] })).toEqual([[], []]);
    expect(await both({ column: 'id', op: 'neq', value: 'nope' })).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    // `is distinct from`: the row holding NULL is distinct from a value no uuid equals, too.
    expect(await both({ column: 'ref', op: 'neq', value: 'nope' })).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    expect(await both({ column: 'ref', op: 'in', value: ['nope', null] })).toEqual([[1], [1]]);
  });

  // Memory ordered the TEXT; Postgres refused the parameter (`22P02`). A range has no "no row" to
  // agree on — every row is above or below SOMETHING — so both drivers refuse it.
  test.each(['gt', 'gte', 'lt', 'lte'] as const)(
    'a range operator %s against text that is no uuid is refused by both drivers',
    async (op) => {
      expect(await both({ column: 'id', op, value: 'nope' })).toEqual(REFUSED);
      expect(await both({ column: 'ref', op, value: 5 })).toEqual(REFUSED);
      expect(await both({ column: 'id', op, value: idAt(1) })).not.toEqual(REFUSED);
    },
  );

  test('a malformed id is a row that is not there: null to findById, X_NOT_FOUND to a write', async () => {
    for (const repo of [memory, postgres]) {
      expect(await repo.findById('nope')).toBeNull();
      const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;
      expect(await repo.update('nope', { n: 9 }).catch(codeOf)).toBe('X_NOT_FOUND');
      expect(await repo.delete('nope').catch(codeOf)).toBe('X_NOT_FOUND');
    }
  });

  // Every spelling Postgres parses as the same sixteen bytes: memory compared the text.
  test.each([idAt(0).toUpperCase(), idAt(0).replaceAll('-', ''), `{${idAt(0)}}`])(
    'the spelling %p is the row both drivers hold',
    async (spelling) => {
      expect(await both({ column: 'id', op: 'eq', value: spelling })).toEqual([[0], [0]]);
      expect(await both({ column: 'id', op: 'in', value: [spelling] })).toEqual([[0], [0]]);
      for (const repo of [memory, postgres]) {
        expect((await repo.findById(spelling))?.id).toBe(idAt(0));
      }
      // Batched, the answer is filed under the key the server printed (`keyOf`), not the spelling.
      const batched = await runWithContext(ctxOf({}), () => postgres.findById(spelling));
      expect(batched?.id).toBe(idAt(0));
    },
  );
});

describe('in: a list longer than one statement can bind', () => {
  const PAST = 70_000;

  test('an in list past the bind budget answers the same on both drivers', async () => {
    const numbers = Array.from({ length: PAST }, (_, at) => at - 10);
    expect(await both({ column: 'n', op: 'in', value: numbers })).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ]);
    const labels = Array.from({ length: PAST }, (_, at) => `a${String(at + 1)}`);
    expect(await both({ column: 'label', op: 'in', value: [...labels, 'q"\\,{}'] })).toEqual([
      [1, 2],
      [1, 2],
    ]);
    const instants = Array.from({ length: PAST }, (_, at) => new Date(Date.UTC(2026, 0, 1) + at));
    expect(await both({ column: 'at', op: 'in', value: instants })).toEqual([[0], [0]]);
    const ids = Array.from({ length: PAST }, (_, at) => idAt(at % 2));
    expect(await both({ column: 'ref', op: 'in', value: [...ids, null, 'nope'] })).toEqual([
      [1],
      [1],
    ]);
    const days = Array.from({ length: PAST }, () => new Date('2025-12-31T00:00:00Z'));
    expect(await both({ column: 'day', op: 'in', value: days })).toEqual([[1], [1]]);
    const flags = Array.from({ length: PAST }, () => false);
    expect(await both({ column: 'flag', op: 'in', value: flags })).toEqual([[1], [1]]);
    const bigs = Array.from({ length: PAST }, (_, at) => BigInt(at) + 10n);
    expect(await both({ column: 'big', op: 'in', value: bigs })).toEqual([[0], [0]]);
  }, 60_000);

  test('a kind with no array form is refused past the budget by both drivers', async () => {
    const lists = Array.from({ length: PAST }, () => ['a']);
    expect(await both({ column: 'tags', op: 'in', value: lists })).toEqual(REFUSED);
  });
});

describe('like: a pattern matches text', () => {
  test.each(['id', 'at', 'day', 'tags', 'n', 'big', 'flag', 'data'] as const)(
    'like is refused on every kind but text/char, identically on both drivers: %s',
    async (column) => {
      expect(await both({ column, op: 'like', value: '1%' })).toEqual(REFUSED);
    },
  );

  test('a text column still matches by pattern in both', async () => {
    expect(await both({ column: 'label', op: 'like', value: 'a%' })).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ]);
  });
});

describe('timestamp(): an instant Postgres cannot read as text is refused by both drivers', () => {
  test.each([
    new Date('0000-12-31T23:59:59.999Z'),
    new Date(Date.UTC(10_000, 0, 1)),
    new Date(-8.64e15),
    '0000-06-01T00:00:00Z',
    '0000-06-01',
  ])('lt %p', async (value) => {
    expect(await both({ column: 'at', op: 'lt', value })).toEqual(REFUSED);
    expect(await both({ column: 'at', op: 'in', value: [value] })).toEqual(REFUSED);
  });

  test.each([
    [new Date('0001-01-01T00:00:00.000Z'), []],
    [new Date('9999-12-31T23:59:59.999Z'), [0, 1, 2]],
    ['0001-01-01T00:00:00+14:00', []],
    ['10000-01-01T00:00:00Z', [0, 1, 2]],
  ] as const)('lt %p still answers, the same rows in both', async (value, expected) => {
    expect(await both({ column: 'at', op: 'lt', value })).toEqual([expected, expected]);
  });
});

const INVALID = [
  ['boolean text', 'flag', 'true'],
  ['text number', 'label', 123],
  ['date invalid', 'day', new Date(Number.NaN)],
  ['date year zero', 'day', new Date('0000-12-31T23:59:59.999Z')],
  ['date negative year', 'day', new Date('-000001-01-01T00:00:00Z')],
  ['date year 10000', 'day', new Date('+010000-01-01T00:00:00Z')],
  ['date minimum JS', 'day', new Date(-8.64e15)],
  ['date maximum JS', 'day', new Date(8.64e15)],
  ['date malformed', 'day', 'tomorrow'],
  ['date rollover', 'day', '2026-02-30'],
  // A TEXT date outside years 0001-9999, which the `Date` rows above never reach: the guard that
  // refuses it lives in a different branch (`dateOperand`'s string arm), so only a string pins it.
  ['date string year zero', 'day', '0000-06-01'],
  ['money whole column', 'price', 5],
  ['currency padded', 'price.currency', 'USD '],
  ['integer array', 'ints', [1, 'oops']],
  ['int4 upper', 'n', '2147483648'],
  ['int4 lower', 'n', '-2147483649'],
  ['int8 upper', 'big', '9223372036854775808'],
  ['int8 lower', 'big', '-9223372036854775809'],
  ['integer malformed', 'n', 'oops'],
  ['numeric malformed', 'amount', 'oops'],
  ['numeric nonfinite', 'amount', Infinity],
  ['numeric hex', 'amount', '0x10'],
  ['JSON object', 'payload', { ok: true }],
  ['JSON string', 'payload', '{}'],
  ['boolean number', 'flag', 1],
  ['text object', 'label', {}],
  ['date number', 'day', 123],
  ['timestamp malformed', 'at', '2026-02-30'],
  ['integer nonfinite', 'n', Number.NaN],
  ['numeric NaN', 'amount', 'NaN'],
  ['numeric empty', 'amount', ''],
  ['money upper', 'price.minor', '9223372036854775808'],
  ['array scalar', 'ints', 1],
  // Boundaries the class must keep refusing when a check LOOSENS: a lowercase or numeric code
  // passes an unanchored or case-blind pattern, a fraction and an empty string pass a `BigInt`
  // round trip, and an exponent past the cap is padding nobody asked for.
  ['currency lowercase', 'price.currency', 'usd'],
  ['currency numeric', 'price.currency', 840],
  ['currency short', 'price.currency', 'US'],
  ['integer fraction', 'n', '1.5'],
  ['integer empty', 'n', ''],
  ['bigint fraction', 'big', '1.0'],
  ['numeric exponent past cap', 'amount', '1e1001'],
  ['array element numeric', 'ints', [1, 2.5]],
] as const;

describe('comparison operands refuse before execution', () => {
  test.each(INVALID)('%s', async (_name, column, value) => {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(await both({ column, op, value })).toEqual(REFUSED);
    }
  });

  test.each(INVALID)(
    '%s in lists and nested short-circuit branches',
    async (_name, column, value) => {
      expect(await both({ column, op: 'in', value: [null, value] })).toEqual(REFUSED);
      expect(
        await both({
          column: '$or',
          op: 'or',
          value: [
            { column: 'n', op: 'gt', value: 0 },
            { column: '$and', op: 'and', value: [{ column, op: 'eq', value }] },
          ],
        }),
      ).toEqual(REFUSED);
    },
  );

  test('empty stores still refuse every invalid operand', async () => {
    const emptyMemory = memoryRepo(rows);
    await pglite.execute(raw('DELETE FROM predicate_operand_rows'));
    try {
      for (const [, column, value] of INVALID) {
        for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'] as const) {
          const predicate = { column, op, value: op === 'in' ? [value] : value };
          expect([await answer(emptyMemory, predicate), await answer(postgres, predicate)]).toEqual(
            REFUSED,
          );
        }
      }
    } finally {
      for (const [index, row] of SEED.entries()) await postgres.insert({ id: idAt(index), ...row });
    }
  });

  test.each([
    ['day', 'gte', new Date('0001-01-01T00:00:00Z'), [0, 1, 2]],
    ['day', 'lt', new Date('0001-01-01T00:00:00Z'), []],
    ['day', 'lte', new Date('9999-12-31T23:59:59.999Z'), [0, 1, 2]],
    ['day', 'gt', new Date('9999-12-31T23:59:59.999Z'), []],
    ['day', 'in', [new Date('0001-01-01'), new Date('9999-12-31')], []],
    ['flag', 'eq', true, [0, 2]],
    ['label', 'eq', 'a1', [1]],
    ['label', 'lt', 'z'.repeat(300), [0, 1, 2]],
    ['price.currency', 'eq', 'USD', [0, 1, 2]],
    ['price.minor', 'eq', '3000000000', [0, 1, 2]],
    ['ints', 'eq', [1, 2], [0, 1, 2]],
    ['ints', 'in', [[1, '002']], [0, 1, 2]],
    ['ints', 'in', [[2, 1]], []],
    ['price.minor', 'lte', '9223372036854775807', [0, 1, 2]],
    ['price.minor', 'gte', '-9223372036854775808', [0, 1, 2]],
    ['amount', 'lt', '100000.12345', [0, 1, 2]],
    ['amount', 'eq', ' +01.25e0 ', [0, 1, 2]],
    ['payload', 'contains', { ok: true }, [0, 1, 2]],
    ['payload', 'eq', null, []],
    ['n', 'lte', '2147483647', [0, 1, 2]],
    ['big', 'gte', '-9223372036854775808', [0, 1, 2]],
    ['n', 'is-not-null', undefined, [0, 1, 2]],
  ] as const)('valid %s %s %p', async (column, op, value, expected) => {
    expect(await both({ column, op, value })).toEqual([expected, expected]);
  });
});

// A `via` inner level is screened as its TARGET's. The target holds no rows here, so nothing but the
// plan-time screen can refuse: without it memory answers [] (no row to match) where Postgres refuses.
const notes = entity('predicate_operand_notes', {
  columns: { id: uuid().primaryKey(), score: integer() },
});

const badHop: Predicate = {
  column: 'ref',
  op: 'via',
  value: {
    entity: 'predicate_operand_notes',
    target: 'id',
    where: [{ column: 'score', op: 'eq', value: 'oops' }],
  },
};

describe('via: an inner level is screened as its target, before any row is read', () => {
  test('a hop whose target operand is refused answers REFUSED on both drivers', async () => {
    expect(await both(badHop)).toEqual(REFUSED);
  });

  test('a hop under a short-circuited or branch is refused too', async () => {
    const nested: Predicate = {
      column: '$or',
      op: 'or',
      value: [
        { column: 'n', op: 'gt', value: 0 },
        { column: '$and', op: 'and', value: [badHop] },
      ],
    };
    expect(await both(nested)).toEqual(REFUSED);
  });
});
