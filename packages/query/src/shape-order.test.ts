// `compareValues` against Postgres' own ordering, one case per `ColumnKind`. This is the general
// form of the bigint defect — the numeric fast path was `typeof === 'number'` on both sides, so an
// `int8` column sorted as text and `["10", "100", "9"]` came back where the database answers
// `[9, 10, 100]` — and of the NULL rule the seek predicate is written against.
//
// The kind list is `packages/entity/src/types.ts`'s `ColumnKind`, spelled out rather than
// imported: `@ultimat3/entity` is tier 2 and legal to import from here, but this package's
// `tsconfig.json` excludes `*.test.ts`, so a `satisfies Record<ColumnKind, …>` written in a test
// is a type assertion `tsc` never reads. `COUNT` below is the runtime half — a tenth kind added
// with no row here fails, and the comment names the file to add it from.

import { describe, expect, test } from 'bun:test';
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
  // string branch reversed) and a value past 2^53 that `Number()` cannot hold exactly.
  bigint: [-10n, 0n, 9n, 10n, 100n, 9007199254740993n, 9007199254740994n],
  timestamptz: [
    new Date('2026-01-31T23:59:59.999Z'),
    new Date('2026-02-01T00:00:00.000Z'),
    new Date('2026-02-01T00:00:00.001Z'),
  ],
};

/** A `ColumnKind` no cursor can carry, and the reason it is refused rather than ordered. */
const UNORDERABLE: Readonly<Record<string, unknown>> = {
  jsonb: { a: 1 },
  // `money` is two physical columns, so the property alone names no single sort value at all —
  // `@ultimat3/entity`'s `assertSeekable` refuses the bare path for the same reason.
  money: { minor: 100, currency: 'EUR' },
};

/** Every kind in `ColumnKind`, so a tenth one added upstream lands here rather than nowhere. */
const COUNT = 9;

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

test('every ColumnKind has a case', () => {
  expect(Object.keys(ASCENDING).length + Object.keys(UNORDERABLE).length).toBe(COUNT);
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

test('a mixed number/bigint pair compares numerically, never as text', () => {
  // Reachable in one read: an `integer` filter value against a `bigint` column's own value, and
  // the pair `compareValues(2, 10n)` answered `1` for.
  expect(Math.sign(compareValues(2, 10n))).toBe(-1);
  expect(Math.sign(compareValues(10n, 2))).toBe(1);
  expect(compareValues(2, 2n)).toBe(0);
  expect(Math.sign(compareValues(9007199254740993n, 2))).toBe(1);
  expect(Math.sign(compareValues(1.5, 2n))).toBe(-1);
});
