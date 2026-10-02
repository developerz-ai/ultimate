// Single responsibility: what a `Predicate` MEANS in the in-memory driver — equality, ordering and
// LIKE. Every rule here exists so the answer matches the one Postgres gives for the same predicate
// on the same column, which is why each is decided by the column's DECLARED KIND and never by the
// JS type of whichever value is in hand: the database decides by the column's type, so a driver
// deciding by `typeof` is answering a different question.

import { keyOf } from './batch-read';
import { arrayContains, arrayOverlaps, jsonContains, jsonHasKey } from './containment';
import { kindOf, valueAt } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { searchInMemory } from './feature-errors';
import { instantMicros } from './instant';
import { isNullish as isNull } from './is-null';
import { likeMatches } from './like';
import { DECIMAL_TEXT, numericOrder } from './numeric-compare';
import type { Predicate } from './tenancy';
import type { ColumnKind } from './types';

const sign = <T extends number | bigint | string>(left: T, right: T): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Two values of one column, ordered as Postgres orders that column. `-1`, `0` or `1` — never a
 * difference, so a `bigint` pair needs no subtraction it cannot express in a `number`.
 */
export const compareByKind = (
  kind: ColumnKind | undefined,
  left: unknown,
  right: unknown,
): number => {
  // NULL is the LARGEST value, which is what `order by` means in Postgres and what `nulls last`
  // ascending / `nulls first` descending spell out (`pg-sql.ts`'s `orderSql`, `@ultimat3/query`'s
  // `compareValues`). Two absences are equal, so the next sort key decides — without this rule a
  // NULL fell through to `String(left) < String(right)` and sorted as the four characters `null`,
  // somewhere in the middle of the alphabet, which is a different listing from the one the
  // database returns and a page boundary cut where the server cuts none.
  if (isNull(left) || isNull(right)) {
    return isNull(left) && isNull(right) ? 0 : isNull(left) ? 1 : -1;
  }
  // A `timestamptz` is compared in MICROSECONDS, which is what the column holds and what a cursor
  // now carries (`cursor.ts`). The two sides are not the same shape and that is the point: a
  // stored row here is a `Date` and a keyset position is a microsecond count, so a `Date`/`Date`
  // test alone would fall through to `String(left) < String(right)` and order a page by the text
  // of an ISO string against a decimal.
  if (kind === 'timestamptz') {
    const before = instantMicros(left);
    const after = instantMicros(right);
    if (before !== undefined && after !== undefined) return sign(before, after);
  }
  if (left instanceof Date && right instanceof Date) return sign(left.getTime(), right.getTime());
  // A `uuid` is ordered as a VALUE — its sixteen bytes, which is the order of its lower-cased
  // text. Compared as written, `…A` sorted before `…a` and the two are one value to Postgres.
  if (kind === 'uuid' && typeof left === 'string' && typeof right === 'string') {
    return sign(keyOf('uuid', left), keyOf('uuid', right));
  }
  // ONE numeric comparison, `numericOrder` — the same call an invariant's `gte`/`eq` makes
  // (`expr.ts`), so a row cannot pass a rule and sort as though it had failed it. Decimal kinds are
  // compared by their digits; anything else only when both sides ARE numbers, and a `number`
  // against a `bigint` is one of those: `String(2) < String(10n)` is false and Postgres says true.
  // `undefined` means the pair is not a numeric comparison, and it falls through as text.
  const numeric = numericOrder(kind !== undefined && DECIMAL_TEXT.has(kind), left, right);
  if (numeric !== undefined) return numeric;
  return sign(String(left), String(right));
};

/**
 * Equality, in the two places `===` is not what the database means. A `Date` compares by identity,
 * so `where({ publishedAt })` would match nothing here and every row there. And Postgres compares a
 * `uuid` as a VALUE — it parses the text and prints it lower-cased — so an id handed in upper case
 * matches the row there and used to miss it here, which is `findById(UPPER)` answering `null` in
 * memory and the row in production. `keyOf` is where that rule already lived, for the batched read.
 */
export const sameValueOfKind = (
  kind: ColumnKind | undefined,
  left: unknown,
  right: unknown,
): boolean => {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  // An instant handed over as ISO text is the instant it names, as Postgres parses the bound
  // parameter: `eq` against a stored `Date` compared an object to a string and matched no row.
  if (kind === 'timestamptz') {
    const stored = instantMicros(left);
    const given = instantMicros(right);
    if (stored !== undefined && given !== undefined) return stored === given;
  }
  if (kind === 'uuid' && typeof left === 'string' && typeof right === 'string') {
    return keyOf('uuid', left) === keyOf('uuid', right);
  }
  // A `bigint()` or `decimal()` row is decimal TEXT and `=` is numeric there: `'2.50' = 2.5` and
  // `'10' = 10` are both true in Postgres, and `===` answered false for each.
  // One driver's `int8` is a JS `bigint` and the literal beside it a `number`: `5n = 5` is true.
  // The same `numericOrder` `compareByKind` asks, so `=` and `order by` cannot disagree on a tie.
  const numeric = numericOrder(kind !== undefined && DECIMAL_TEXT.has(kind), left, right);
  if (numeric !== undefined) return numeric === 0;
  return left === right;
};

/** One predicate against one stored row, in the meaning the Postgres driver compiles it to. */
export const matchesPredicate = <Row>(
  entity: EntityCore<Row>,
  row: unknown,
  predicate: Predicate,
): boolean => {
  // BEFORE anything is read off the row. A full-text match has no in-memory meaning — see
  // `searchInMemory` — and `valueAt(row, '$search')` would answer `undefined`, which every
  // comparison below reads as NULL and silently turns into "no rows".
  if (predicate.op === 'matches') throw searchInMemory(entity.$name);
  // The column's declared kind, resolved once — `price.minor` included, which is the path a money
  // predicate and a money sort key both name.
  const kind = kindOf(entity, predicate.column);
  const actual = valueAt(row, predicate.column);
  /**
   * `col = <value>`, with SQL's three-valued logic on both sides: a NULL is never EQUAL to
   * anything, the other NULL included, so `equals` answers false the moment either side is one
   * and the operators below decide what that means for them.
   *
   * The row side reads through `isNull`, so a row that never NAMED a nullable column is the same
   * row as one that stored `null` — which is what the table holds for both, and what `is-null`
   * has always answered here. `===` made them two: `eq null` skipped the absent row, `in [null]`
   * missed it and `neq null` answered it, each the opposite of the same predicate in production.
   * A `money()` column holding NULL reaches this every time, with no hand-built row at all —
   * `valueAt(row, 'price.minor')` has nothing to read.
   */
  const equals = (candidate: unknown): boolean =>
    !isNull(actual) && !isNull(candidate) && sameValueOfKind(kind, actual, candidate);
  // `col > NULL` is UNKNOWN in SQL and UNKNOWN is not a match, so a NULL on EITHER side matches no
  // row here either — `predicateSql` emits a bare `"col" > $1` and Postgres returns nothing. Without
  // this the fall-through compared `String(null)` as the text `"null"`, which sorts after `"5"` and
  // before `"z"`: `gt(seats, 5)` answered the null row in memory and never in production, and
  // `lt(seats, null)` answered every row. The guard is HERE and not in `compareByKind`, which also
  // orders a page — a sort puts NULLs last (`asc nulls last`) rather than dropping them.
  const unknown = (): boolean => isNull(actual) || isNull(predicate.value);
  const order = (): number => compareByKind(kind, actual, predicate.value);
  switch (predicate.op) {
    // `predicateSql` compiles a null operand to `"col" is null` rather than binding it, so this
    // is the same predicate, not a widening of it.
    case 'eq':
      return predicate.value === null ? isNull(actual) : equals(predicate.value);
    // `is distinct from` reads a NULL as a value on BOTH sides: TRUE where one side is null and
    // the other is not, FALSE where both are. A bound `undefined` is a NULL parameter there, so
    // the operand side reads through `isNull` and the two spellings mean one thing.
    case 'neq':
      return isNull(predicate.value) ? !isNull(actual) : !equals(predicate.value);
    // `in` reads a LIST or nothing: an operand that is not an array matches no row, which is what
    // `predicateSql` now compiles it to and what `@ultimat3/query` answers for the same operand.
    // A NULL inside the list is asked as `is null` beside the list there, for the same reason.
    case 'in':
      return (
        Array.isArray(predicate.value) &&
        predicate.value.some((candidate) =>
          isNull(candidate) ? isNull(actual) : equals(candidate),
        )
      );
    case 'gt':
      return !unknown() && order() > 0;
    case 'gte':
      return !unknown() && order() >= 0;
    case 'lt':
      return !unknown() && order() < 0;
    case 'lte':
      return !unknown() && order() <= 0;
    // Real LIKE semantics, so `'draft%'` means "starts with" here exactly as it does in Postgres.
    // Treating the pattern as a substring would make the two drivers disagree.
    case 'like':
      return !unknown() && likeMatches(entity.$name, String(predicate.value), String(actual));
    case 'is-null':
      return isNull(actual);
    case 'is-not-null':
      return !isNull(actual);
    // The containment half, decided by the column's DECLARED kind exactly as everything above it
    // is: `@>` on a `jsonb` is recursive structural containment and `@>` on an array is plain
    // element containment, and those are two different operators that happen to share a symbol.
    // A NULL column value matches nothing, which is what the SQL answers too.
    case 'contains':
      return !isNull(actual) && containsBy(kind, actual, predicate.value);
    case 'contained-by':
      return !isNull(actual) && containsBy(kind, predicate.value, actual);
    // `&&` is arrays only. A `jsonb` column reaching it is refused rather than guessed at: there
    // is no `jsonb && jsonb` in Postgres, so any answer here would be one no statement can make.
    case 'overlaps':
      return (
        !isNull(actual) &&
        arrayOverlaps(
          asArray(entity, predicate, actual),
          asArray(entity, predicate, predicate.value),
        )
      );
    case 'has-key':
      return jsonHasKey(actual, predicate.value);
  }
};

/** `left @> right`, under the rule the LEFT column's kind decides. */
const containsBy = (kind: ColumnKind | undefined, left: unknown, right: unknown): boolean =>
  kind === 'jsonb'
    ? jsonContains(left, right)
    : arrayContains(Array.isArray(left) ? left : [left], Array.isArray(right) ? right : [right]);

/**
 * The operand of an array-only operator. A `jsonb` column here is the caller asking for an
 * operator Postgres does not have on that type, so it is refused where they wrote it rather than
 * answered with something the database never would.
 */
const asArray = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  value: unknown,
): readonly unknown[] => {
  if (kindOf(entity, predicate.column) === 'jsonb') {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entity.$name}.${predicate.column} is jsonb, and Postgres has no && (overlaps) operator for jsonb`,
      fix: `${entity.$name}.andWhere('${predicate.column}', 'contains', <value>)   # @> matches nested structure; && is for arrayOf() columns`,
    });
  }
  return Array.isArray(value) ? value : [value];
};
