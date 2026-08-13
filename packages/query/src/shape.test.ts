// The read vocabulary's two rules, pinned where every reader of them can only agree: NULL is one
// absence that `=`/`!=`/`in` read as a value and `>`/`<` read as unknown, and `totalOrder` is the
// order a read is served in. `compareRows`, `isAfterKey` and the matcher's insertion position all
// call these, so one wrong answer here moves rows on three surfaces at once.

import { describe, expect, test } from 'bun:test';
import type { Filter, OrderKey } from './shape';
import { compareRows, compareValues, isNull, matchesFilter, totalOrder } from './shape';

interface Post {
  readonly id: string;
  readonly publishedAt?: string | null;
  readonly score?: number | null;
}

const published: Post = { id: 'a', publishedAt: '2026-08-01', score: 10 };
const draft: Post = { id: 'b', publishedAt: null, score: null };
/** No column at all: what a fixture row and a projection both look like. */
const bare: Post = { id: 'c' };

const filter = (column: string, op: Filter['op'], value: unknown): Filter => ({
  column,
  op,
  value,
});

// `where({ deletedAt: null })` has to mean in memory what `is null` means in Postgres, or the
// same read answers differently depending on which source served it.
describe('NULL is a value to `=`, `!=` and `in`', () => {
  test('`= null` matches a null column and only a null column', () => {
    expect(matchesFilter(draft, filter('publishedAt', '=', null))).toBe(true);
    expect(matchesFilter(published, filter('publishedAt', '=', null))).toBe(false);
  });

  test('a column the row omits is the same absence as an explicit null', () => {
    // The row arrived without the key; the database would have called it NULL.
    expect(matchesFilter(bare, filter('publishedAt', '=', null))).toBe(true);
    expect(matchesFilter(bare, filter('publishedAt', '=', '2026-08-01'))).toBe(false);
  });

  test('`!= null` keeps only the rows that have a value', () => {
    expect(matchesFilter(published, filter('publishedAt', '!=', null))).toBe(true);
    expect(matchesFilter(draft, filter('publishedAt', '!=', null))).toBe(false);
    expect(matchesFilter(bare, filter('publishedAt', '!=', null))).toBe(false);
  });

  test('`!= value` matches a null column — `is distinct from`, not `!=`', () => {
    expect(matchesFilter(draft, filter('publishedAt', '!=', '2026-08-01'))).toBe(true);
  });

  test('`in` reads null as one of the listed values', () => {
    const list = filter('publishedAt', 'in', [null, '2026-08-01']);
    expect(matchesFilter(draft, list)).toBe(true);
    expect(matchesFilter(published, list)).toBe(true);
    expect(matchesFilter({ id: 'd', publishedAt: '2026-01-01' }, list)).toBe(false);
  });
});

// `col > NULL` is unknown in SQL and unknown never matches. In memory it used to compare the
// string `"null"`, so a null score sorted past `5` and a draft row landed in a `score > 5` feed.
describe('NULL is unknown to an ordering operator', () => {
  test('a null column never satisfies a comparison', () => {
    expect(matchesFilter(draft, filter('score', '>', 5))).toBe(false);
    expect(matchesFilter(draft, filter('score', '>=', 5))).toBe(false);
    expect(matchesFilter(draft, filter('score', '<', 5))).toBe(false);
    expect(matchesFilter(draft, filter('score', '<=', 5))).toBe(false);
  });

  test('a null argument matches nothing at all, not even a null column', () => {
    expect(matchesFilter(published, filter('score', '>', null))).toBe(false);
    expect(matchesFilter(published, filter('score', '<=', null))).toBe(false);
    expect(matchesFilter(draft, filter('score', '>=', null))).toBe(false);
  });

  test('a value still compares normally', () => {
    expect(matchesFilter(published, filter('score', '>', 5))).toBe(true);
    expect(matchesFilter(published, filter('score', '<', 5))).toBe(false);
  });
});

// Sorting is where NULL is a value again: Postgres puts it last ascending and first descending,
// so `compareValues` says the same thing and `Builder.toSQL()` writes it down.
describe('NULL sorts after every value', () => {
  test('null is greater than any value and equal to itself', () => {
    expect(compareValues(null, 'zzz')).toBeGreaterThan(0);
    expect(compareValues('zzz', null)).toBeLessThan(0);
    expect(compareValues(null, 0)).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
  });

  test('a missing column sorts where an explicit null sorts', () => {
    expect(compareValues(undefined, null)).toBe(0);
    expect(compareValues(undefined, 'a')).toBeGreaterThan(0);
  });

  test('`asc` puts the nulls last and `desc` puts them first', () => {
    const asc: readonly OrderKey[] = [{ column: 'publishedAt', direction: 'asc' }];
    const desc: readonly OrderKey[] = [{ column: 'publishedAt', direction: 'desc' }];
    expect(compareRows(draft, published, asc)).toBeGreaterThan(0);
    expect(compareRows(draft, published, desc)).toBeLessThan(0);
  });

  test('rows sort into the order the database would return', () => {
    const rows = [draft, published, { id: 'd', publishedAt: '2026-01-01' }, bare];
    const asc: readonly OrderKey[] = [
      { column: 'publishedAt', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ];
    const sorted = [...rows].sort((a, b) => compareRows(a, b, asc));
    expect(sorted.map((row) => row.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

// The order a page is served in, and the one the matcher and `isAfterKey` have to read too.
describe('totalOrder', () => {
  test('appends `id asc` so two rows with the same sort value have an order at all', () => {
    expect(totalOrder([{ column: 'createdAt', direction: 'desc' }])).toEqual([
      { column: 'createdAt', direction: 'desc' },
      { column: 'id', direction: 'asc' },
    ]);
  });

  test('an ordering that already names id is total — a second term compares the key to itself', () => {
    const byId: readonly OrderKey[] = [{ column: 'id', direction: 'desc' }];
    expect(totalOrder(byId)).toEqual(byId);
  });

  test('an unordered read still gets a tiebreak to make one out of', () => {
    expect(totalOrder([])).toEqual([{ column: 'id', direction: 'asc' }]);
  });
});

describe('isNull', () => {
  test('is null and undefined, and nothing else falsy', () => {
    expect(isNull(null)).toBe(true);
    expect(isNull(undefined)).toBe(true);
    expect(isNull(0)).toBe(false);
    expect(isNull('')).toBe(false);
    expect(isNull(false)).toBe(false);
  });
});
