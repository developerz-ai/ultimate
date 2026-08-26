// Single responsibility: what `@>`, `<@`, `&&` and a JSON key test MEAN, written once so the
// in-memory driver answers what Postgres answers. A `jsonb` or an `arrayOf()` column was declared
// and then unfilterable — the ten-operator vocabulary had nothing that could look inside one — so
// an app with either had to leave the query language for hand-written SQL, which is the one path
// in this framework with no tenancy guard on it.
//
// Every rule here is Postgres', reproduced rather than approximated. Where the two could not be
// made to agree the operator is refused instead (`memory-match.ts`), never guessed at.

import { isNullish as isNull } from './is-null';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Neither an object nor an array — which is exactly the set the top-level exception below covers. */
const isScalar = (value: unknown): boolean => !isRecord(value) && !Array.isArray(value);

/**
 * Two ELEMENTS, equal. `===` plus the one case it gets wrong here: an `arrayOf(timestamp())` row
 * holds `Date` objects, and two Dates for the same instant are two references — the same trap
 * `sameValueOfKind` closes for a predicate, one operator along.
 *
 * Nothing deeper, and that is a property rather than an omission: `arrayOf()` refuses `jsonb`,
 * `bytea`, `money` and a nested array at declaration, so an element is always a scalar or a Date.
 */
const sameElement = (left: unknown, right: unknown): boolean => {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
};

/**
 * `left @> right` for `jsonb`, to the letter of Postgres' definition — each clause below measured
 * on Postgres 16 rather than read off a summary, because three of them are easy to state wrongly:
 *
 * - two objects: every key of `right` is present in `left` and its value is contained by the one
 *   there — recursively, which is what makes `data @> '{"a":{"b":1}}'` a NESTED match and why this
 *   package ships no second path-expression language beside it (axiom 1).
 * - two arrays: every element of `right` is contained by SOME element of `left`, which is why
 *   `[1,2,3] @> [3,1]` holds and order never matters.
 * - an array on the left and a PRIMITIVE on the right, **at the top level only**: `'[1,2]' @> '2'`
 *   is true. Both halves of that sentence are load-bearing and both were wrong here first —
 *   `'{"list":[1,2,3]}' @> '{"list":2}'` is FALSE (the exception does not recurse) and
 *   `'[{"a":1}]' @> '{"a":1}'` is FALSE (it does not extend to composites).
 * - anything else: element equality, which for a jsonb scalar is what it sounds like.
 */
export const jsonContains = (left: unknown, right: unknown): boolean => contains(left, right, true);

const contains = (left: unknown, right: unknown, top: boolean): boolean => {
  if (Array.isArray(left)) {
    if (Array.isArray(right)) {
      return right.every((item) => left.some((candidate) => contains(candidate, item, false)));
    }
    return top && isScalar(right) && left.some((candidate) => sameElement(candidate, right));
  }
  if (isRecord(left) && isRecord(right)) {
    return Object.keys(right).every(
      (key) => Object.hasOwn(left, key) && contains(left[key], right[key], false),
    );
  }
  return isScalar(left) && isScalar(right) && sameElement(left, right);
};

/**
 * `left @> right` for a SQL array, which is a different operator with a different rule: element
 * containment is plain equality, never the recursive one above, because an array's elements are
 * scalars of one declared type rather than arbitrary JSON. An empty right-hand side is contained
 * by every array, which is what Postgres answers.
 */
export const arrayContains = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  right.every((item) => left.some((candidate) => sameElement(candidate, item)));

/**
 * `left && right`: they share at least one element. Arrays only — `jsonb` has no `&&` — and the
 * bound is the opposite way round from `@>`: an EMPTY operand overlaps nothing, where it is
 * contained by everything.
 */
export const arrayOverlaps = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  right.some((item) => left.some((candidate) => sameElement(candidate, item)));

/**
 * `jsonb_exists(value, key)` — the function form of the `?` operator, which is what the SQL side
 * emits so a literal `?` can never be read as a parameter placeholder by anything on the way.
 *
 * Three shapes, all of them Postgres': a top-level key of an object, a string ELEMENT of an array,
 * and a string value equal to the key. A number never matches — `jsonb_exists('[1]', '1')` is
 * false there, and a `String(item) === key` here would have made it true.
 */
export const jsonHasKey = (value: unknown, key: unknown): boolean => {
  if (typeof key !== 'string' || isNull(value)) return false;
  if (Array.isArray(value)) return value.some((item) => item === key);
  if (isRecord(value)) return Object.hasOwn(value, key);
  return value === key;
};
