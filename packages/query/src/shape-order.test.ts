// `compareValues` against Postgres' own ordering, one case per `ColumnKind`. This is the general
// form of the bigint defect — the numeric fast path was `typeof === 'number'` on both sides, so an
// `int8` column sorted as text and `["10", "100", "9"]` came back where the database answers
// `[9, 10, 100]` — and of the NULL rule the seek predicate is written against.
//
// The kind list is IMPORTED, `As of 2026-08`: `COLUMN_KINDS` is the runtime array
// `@ultimat3/entity`'s `ColumnKind` derives from, and `@ultimat3/entity` is tier 2, so a tier-3
// test may read it. It was spelled out here instead, with `const COUNT = 9` beside a union of
// THIRTEEN members — `9 === 9`, a test that could not fail, with `numeric`, `date`, `bytea` and
// `array` carrying no case at all. A value import works where the type-level `satisfies` this
// file's header used to argue for does not: `tsconfig.json` excludes `*.test.ts`, so `tsc` never
// reads an assertion written here, but `bun test` runs every line of one.

import { describe, expect, test } from 'bun:test';
import { COLUMN_KINDS } from '@ultimat3/entity';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import { compareRows, compareValues } from './shape';

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
  // The kind the defect was about, and the two magnitudes that decide it: 9 before 10 (which the
  // string branch reversed) and a value past 2^53 that `Number()` cannot hold exactly. This is the
  // JS-`bigint` form — the one a cursor revives and PGlite returns. The TEXT form the repository
  // hands back is `DECLARED_GAP` below, and it is the same kind twice on purpose.
  bigint: [-10n, 0n, 9n, 10n, 100n, 9007199254740993n, 9007199254740994n],
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
  // Both row values are objects with no ordering `compareValues` could express: Postgres orders a
  // `bytea` by its bytes and an array element-wise, and `String(new Uint8Array([2]))` is `"2"`.
  bytea: new Uint8Array([1, 2, 3]),
  array: ['a', 'b'],
};

/**
 * The kinds this package gets WRONG, pinned as the gap they are rather than as behaviour anyone
 * should copy. `@ultimat3/entity`'s `bigint()` and `decimal()` both hand digits back as TEXT
 * (`columns-data.ts`), and text is what reaches a `QueryShape`: `["9","10","100","2"]` sorts to
 * `["10","100","2","9"]` here and to `["2","9","10","100"]` in the database.
 *
 * It is a DECLARATION gap and not a duplication one, which is why it is not closed by calling
 * `@ultimat3/core`'s `compareDecimalText` from `compareValues`. That function answers only for a
 * caller that knows the column's declared kind, and `QueryShape.orderBy` is a name and a direction
 * — nothing here can tell a `numeric` holding `"10"` from a `text` holding `"10"`, and Postgres
 * orders the second lexically. A comparator guessing "both sides look like a decimal" would trade
 * this disagreement with the SQL it prints for a new one on every `text` column of digits. Closing
 * it means an `OrderKey` that carries a kind, from `sourceFor` down; until then these assertions
 * are what stops the gap from being silently re-discovered.
 */
const DECLARED_GAP: Readonly<Record<string, readonly string[]>> = {
  numeric: ['2', '9', '10', '100'],
  bigint: ['2', '9', '10', '100'],
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
  const covered = new Set([
    ...Object.keys(ASCENDING),
    ...Object.keys(UNORDERABLE),
    ...Object.keys(DECLARED_GAP),
  ]);
  expect([...covered].sort()).toEqual([...COLUMN_KINDS].sort());
});

describe.each(Object.entries(ASCENDING))('%s orders as Postgres orders it', (_kind, values) => {
  test('every pair compares in the declared direction, and each value equals itself', () => {
    for (const [index, left] of values.entries()) {
      expect(compareValues(left, left)).toBe(0);
      for (const right of values.slice(index + 1)) {
        expect(Math.sign(compareValues(left, right))).toBe(-1);
        expect(Math.sign(compareValues(right, left))).toBe(1);
      }
    }
  });

  test('a shuffled column sorts back into the order the database returns', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rows = shuffled(values, seed).map((value) => ({ value }));
      const sorted = [...rows].sort((a, b) =>
        compareRows(a, b, [{ column: 'value', direction: 'asc' }]),
      );
      expect(sorted.map((row) => row.value)).toEqual([...values]);
    }
  });

  test('NULL is the largest value and equal to itself — `asc nulls last`, written down', () => {
    // A column the row omits is the same absence as a stored NULL, which is why both are here.
    for (const absent of [null, undefined]) {
      expect(compareValues(absent, absent)).toBe(0);
      for (const value of values) {
        expect(Math.sign(compareValues(absent, value))).toBe(1);
        expect(Math.sign(compareValues(value, absent))).toBe(-1);
      }
    }
  });

  test('the cursor round trip preserves every comparison', () => {
    const revived = reviveSortKey(JSON.parse(JSON.stringify(values.map(serializeSortValue))));
    for (const [index, left] of revived.entries()) {
      for (const [other, right] of revived.entries()) {
        expect(Math.sign(compareValues(left, right))).toBe(Math.sign(index - other));
      }
    }
  });
});

describe.each(Object.entries(UNORDERABLE))('%s carries no cursor position', (_kind, value) => {
  test('it is refused where the cursor is minted, not silently stringified', () => {
    expect(() => serializeSortValue(value)).toThrow();
  });
});

describe.each(Object.entries(DECLARED_GAP))(
  '%s row values are decimal TEXT, and this package has no kind to decide by',
  (kind, ascending) => {
    test('sorts lexically here — the gap, not the answer', () => {
      const sorted = [...ascending].sort(compareValues);
      // What Postgres answers for a `numeric` or an `int8` is `ascending` itself; what this
      // answers is character order. Both halves are asserted, so a change in either direction
      // lands here: closing the gap fails the second expectation and has to delete it, and
      // widening it fails the first.
      expect(sorted).toEqual([...ascending].sort());
      expect(sorted).not.toEqual([...ascending]);
      expect(kind === 'numeric' || kind === 'bigint').toBe(true);
    });
  },
);

test('a cursor bigint against a stored decimal string is the same gap, one form apart', () => {
  // `cursor-value.ts` revives a tagged `bigint` as a JS `bigint`, and `isAfterKey` compares it
  // against the row's own value — which the repository handed back as text. `9n` vs `"10"` is the
  // pair that cuts page two where the database does not.
  // `@ultimat3/entity`'s `compareByKind('bigint', 9n, '10')` answers `-1`, because it is handed
  // the column's kind; nothing here is. Its own suite asserts that half.
  expect(Math.sign(compareValues(9n, '10'))).toBe(1);
});

test('a mixed number/bigint pair compares numerically, never as text', () => {
  // Reachable in one read: an `integer` filter value against a `bigint` column's own value, and
  // the pair `compareValues(2, 10n)` answered `1` for.
  expect(Math.sign(compareValues(2, 10n))).toBe(-1);
  expect(Math.sign(compareValues(10n, 2))).toBe(1);
  expect(compareValues(2, 2n)).toBe(0);
  expect(Math.sign(compareValues(9007199254740993n, 2))).toBe(1);
  expect(Math.sign(compareValues(1.5, 2n))).toBe(-1);
});
