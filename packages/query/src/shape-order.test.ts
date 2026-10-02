// Row ordering against Postgres' own, one case per `ColumnKind` — `compareRows` under the
// column's DECLARED kind, which is how `@ultimat3/entity`'s `compareByKind` decides and how the
// database does. Until 2026-10 this package kept its own comparator and decided by `typeof`: a
// `bigint()` or `decimal()` row is decimal TEXT, so `["10", "100", "9"]` came back where the
// database answers `[9, 10, 100]`, and this file pinned that as a declared gap. It is closed, and
// `compare-parity.test.ts` holds both packages to one table.
//
// The kind list is IMPORTED: `COLUMN_KINDS` is the runtime array `@ultimat3/entity`'s `ColumnKind`
// derives from, so a kind added there with no case here fails the first test below. A value
// import works where a type-level `satisfies` does not — `tsconfig.json` excludes `*.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { ColumnKind } from '@ultimat3/entity';
import { COLUMN_KINDS } from '@ultimat3/entity';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import { compareRows } from './shape';

/** `left` against `right` as one ascending key of the given kind orders two rows. */
const order = (kind: ColumnKind | undefined, left: unknown, right: unknown): number =>
  compareRows(
    { value: left },
    { value: right },
    [{ column: 'value', direction: 'asc' }],
    () => kind,
  );

/**
 * Ascending order, exactly as `order by "col" asc nulls last` returns it, in the JS shape a row
 * holds for that kind. ASCII-only text, because a Postgres collation decides `'a'` vs `'B'` and a
 * claim about one deployment's `lc_collate` is not a claim about the ordering rule.
 */
const ASCENDING: Readonly<Record<string, readonly unknown[]>> = {
  uuid: [
    '00000000-0000-7000-8000-000000000001',
    '00000000-0000-7000-8000-000000000002',
    '10000000-0000-7000-8000-000000000000',
  ],
  text: ['A', 'B', 'a', 'aa', 'b'],
  char: ['EUR', 'GBP', 'USD'],
  boolean: [false, true],
  integer: [-10, -1, 0, 1, 9, 10, 100],
  // The kind the defect was about, in the form a repository row holds — decimal TEXT — and the
  // magnitudes that decide it: 9 before 10 (which a string comparison reverses) and two values
  // past 2^53 that `Number()` cannot tell apart.
  bigint: ['-10', '0', '2', '9', '10', '100', '9007199254740993', '9007199254740994'],
  // `decimal()`: text again, and a fraction that must not be read as a longer integer.
  numeric: ['-10.5', '-0.25', '0', '2.50', '9', '9.75', '10', '100.0001'],
  timestamptz: [
    new Date('2026-01-31T23:59:59.999Z'),
    new Date('2026-02-01T00:00:00.000Z'),
    new Date('2026-02-01T00:00:00.001Z'),
  ],
  // `date()`'s row value is `@ultimat3/time`'s `PlainDate` — a zero-padded `YYYY-MM-DD` string, so
  // character order IS calendar order and the string branch is already the right answer.
  date: ['2025-12-31', '2026-01-01', '2026-01-09', '2026-01-10', '2026-02-01'],
};

/** A `ColumnKind` no cursor can carry, and the reason it is refused rather than ordered. */
const UNORDERABLE: Readonly<Record<string, unknown>> = {
  jsonb: { a: 1 },
  // `money` is two physical columns, so the property alone names no single sort value at all —
  // `@ultimat3/entity`'s `assertSeekable` refuses the bare path for the same reason.
  money: { minor: 100, currency: 'EUR' },
  // Both row values are objects with no ordering a comparator could express: Postgres orders a
  // `bytea` by its bytes and an array element-wise, and `String(new Uint8Array([2]))` is `"2"`.
  bytea: new Uint8Array([1, 2, 3]),
  array: ['a', 'b'],
};

const shuffled = <T>(values: readonly T[], seed: number): readonly T[] => {
  const out = [...values];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap] as T, out[index] as T];
  }
  return out;
};

test('every ColumnKind has a case, read off the list the type itself derives from', () => {
  const covered = new Set([...Object.keys(ASCENDING), ...Object.keys(UNORDERABLE)]);
  expect([...covered].sort()).toEqual([...COLUMN_KINDS].sort());
});

describe.each(Object.entries(ASCENDING))('%s orders as Postgres orders it', (name, values) => {
  const kind = name as ColumnKind;

  test('every pair compares in the declared direction, and each value equals itself', () => {
    for (const [index, left] of values.entries()) {
      expect(order(kind, left, left)).toBe(0);
      for (const right of values.slice(index + 1)) {
        expect(order(kind, left, right)).toBe(-1);
        expect(order(kind, right, left)).toBe(1);
      }
    }
  });

  test('a shuffled column sorts back into the order the database returns', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rows = shuffled(values, seed).map((value) => ({ value }));
      const sorted = [...rows].sort((a, b) =>
        compareRows(a, b, [{ column: 'value', direction: 'asc' }], () => kind),
      );
      expect(sorted.map((row) => row.value)).toEqual([...values]);
    }
  });

  test('NULL is the largest value and equal to itself — `asc nulls last`, written down', () => {
    // A column the row omits is the same absence as a stored NULL, which is why both are here.
    for (const absent of [null, undefined]) {
      expect(order(kind, absent, absent)).toBe(0);
      for (const value of values) {
        expect(order(kind, absent, value)).toBe(1);
        expect(order(kind, value, absent)).toBe(-1);
      }
    }
  });

  test('the cursor round trip preserves every comparison', () => {
    const revived = reviveSortKey(JSON.parse(JSON.stringify(values.map(serializeSortValue))));
    for (const [index, left] of revived.entries()) {
      for (const [other, right] of revived.entries()) {
        expect(order(kind, left, right)).toBe(Math.sign(index - other));
      }
    }
  });
});

describe.each(Object.entries(UNORDERABLE))('%s carries no cursor position', (_kind, value) => {
  test('it is refused where the cursor is minted, not silently stringified', () => {
    expect(() => serializeSortValue(value)).toThrow();
  });
});

test('a JS bigint is ordered with the decimal text of the same column', () => {
  // The other form an `int8` arrives in: a cursor revives a tagged `bigint` as a JS `bigint`, and
  // one driver returns one. Against the row's own text, `9n` vs `"10"` was the pair that cut page
  // two where the database does not.
  expect(order('bigint', 9n, '10')).toBe(-1);
  expect(order('bigint', '10', 9n)).toBe(1);
  expect(order('bigint', 10n, '10')).toBe(0);
  expect(order('bigint', 9007199254740993n, '9007199254740992')).toBe(1);
});

test('digits in a column with no declared kind are text, as Postgres orders a text column', () => {
  // A relation no entity declares has no kind to decide by, and guessing "these look numeric"
  // would disagree with the SQL the same read prints for a `text` column of digits.
  expect(order(undefined, '10', '9')).toBe(-1);
  expect(order('text', '10', '9')).toBe(-1);
});

test('a mixed number/bigint pair compares numerically, never as text', () => {
  // Reachable with no kind at all: one driver's `int8` beside a `number` literal.
  expect(order(undefined, 2, 10n)).toBe(-1);
  expect(order(undefined, 10n, 2)).toBe(1);
  expect(order(undefined, 2, 2n)).toBe(0);
  expect(order(undefined, 9007199254740993n, 2)).toBe(1);
  expect(order(undefined, 1.5, 2n)).toBe(-1);
});
