// The containment rules on their own, with no driver in the way. `pg-containment.live.test.ts`
// proves the same answers against a real server and against memory side by side; this file is
// where each rule is stated once, including the ones a corpus would have to be adversarial to
// reach.

import { describe, expect, test } from 'bun:test';
import { arrayContains, arrayOverlaps, jsonContains, jsonHasKey } from './containment';

describe('jsonContains — objects', () => {
  test('every key of the right side must be present and contained', () => {
    expect(jsonContains({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(jsonContains({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test('nested, which is what stands in for a path language', () => {
    expect(jsonContains({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true);
    expect(jsonContains({ a: { b: { c: 1 } } }, { a: { b: {} } })).toBe(true);
    expect(jsonContains({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
  });

  test('an empty object is contained by every object', () => {
    expect(jsonContains({ a: 1 }, {})).toBe(true);
  });

  test('a key present with a different value is not a match', () => {
    expect(jsonContains({ a: null }, { a: 1 })).toBe(false);
    expect(jsonContains({ a: 1 }, { a: null })).toBe(false);
  });
});

describe('jsonContains — arrays', () => {
  test('order never matters and duplicates never matter', () => {
    expect(jsonContains([1, 2, 3], [3, 1])).toBe(true);
    expect(jsonContains([1, 2, 3], [1, 1])).toBe(true);
    expect(jsonContains([1, 2], [4])).toBe(false);
  });

  test('an element is contained recursively, so nested arrays match', () => {
    expect(jsonContains([[1, 2]], [[1]])).toBe(true);
    expect(jsonContains([{ a: 1, b: 2 }], [{ a: 1 }])).toBe(true);
  });

  test('a bare scalar is contained AT THE TOP LEVEL, and only there', () => {
    // Postgres: `'[1,2,3]' @> '2'` is true and `'{"list":[1,2,3]}' @> '{"list":2}'` is FALSE — the
    // exception is documented as not applying recursively, and measured on Postgres 16 to confirm
    // it. An implementation that applies it at every depth answers true for the second.
    expect(jsonContains([1, 2, 3], 2)).toBe(true);
    expect(jsonContains({ list: [1, 2, 3] }, { list: 2 })).toBe(false);
    expect(jsonContains({ list: [1, 2, 3] }, { list: [2] })).toBe(true);
  });

  test('an empty array is contained by every array', () => {
    expect(jsonContains([1], [])).toBe(true);
  });

  test('the top-level exception is PRIMITIVES only, not objects and not arrays', () => {
    // Measured on Postgres 16: `'[{"a":1}]' @> '{"a":1}'` is false and `'[[1,2]]' @> '[1,2]'` is
    // false. An implementation that let the exception cover composites answers true for the first,
    // which is a filter matching rows the database never would.
    expect(jsonContains([{ a: 1 }], { a: 1 })).toBe(false);
    expect(jsonContains([{ a: 1, b: 2 }], { a: 1 })).toBe(false);
    expect(jsonContains([[1, 2]], [1, 2])).toBe(false);
    // And the primitive it IS for, including null.
    expect(jsonContains([1, 2], 2)).toBe(true);
    expect(jsonContains([null], null)).toBe(true);
  });
});

describe('arrayContains and arrayOverlaps', () => {
  test('a SQL array contains by plain element equality, never recursively', () => {
    // Two different operators sharing one symbol: an array's elements are scalars of one declared
    // type, so `@>` there is membership and nothing deeper.
    expect(arrayContains(['red', 'blue'], ['red'])).toBe(true);
    expect(arrayContains(['red'], ['red', 'blue'])).toBe(false);
    expect(arrayContains([], [])).toBe(true);
    expect(arrayContains([], ['red'])).toBe(false);
  });

  test('a Date element compares by its instant, never by reference', () => {
    // `arrayOf(timestamp())` rows hold `Date` objects, and two Dates for one instant are two
    // references — the trap `sameValueOfKind` closes for a predicate, one operator along.
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(arrayContains([at], [new Date(at.getTime())])).toBe(true);
    expect(arrayOverlaps([at], [new Date(at.getTime())])).toBe(true);
    expect(arrayContains([at], [new Date(at.getTime() + 1)])).toBe(false);
  });

  test('overlaps is "shares at least one", which is the opposite bound', () => {
    expect(arrayOverlaps(['red', 'blue'], ['blue', 'green'])).toBe(true);
    expect(arrayOverlaps(['red'], ['green'])).toBe(false);
    // An empty operand overlaps nothing, where it is CONTAINED by everything.
    expect(arrayOverlaps(['red'], [])).toBe(false);
    expect(arrayContains(['red'], [])).toBe(true);
  });
});

describe('jsonHasKey', () => {
  test('a top-level key of an object', () => {
    expect(jsonHasKey({ a: 1 }, 'a')).toBe(true);
    expect(jsonHasKey({ a: 1 }, 'b')).toBe(false);
    // Nested is `contains`, not this — matching `b` here would answer for a key no caller named.
    expect(jsonHasKey({ a: { b: 1 } }, 'b')).toBe(false);
  });

  test('a string ELEMENT of an array, and a number never', () => {
    // `jsonb_exists('[1]', '1')` is false in Postgres. A `String(item) === key` would make it true.
    expect(jsonHasKey(['a', 'b'], 'a')).toBe(true);
    expect(jsonHasKey([1, 2], '1')).toBe(false);
  });

  test('a bare string equals the key; anything else is false', () => {
    expect(jsonHasKey('a', 'a')).toBe(true);
    expect(jsonHasKey(null, 'a')).toBe(false);
    expect(jsonHasKey({ a: 1 }, 1)).toBe(false);
  });
});
