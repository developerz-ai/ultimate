// Single responsibility: what a `Predicate` MEANS in the in-memory driver — equality, ordering and
// LIKE. Every rule here exists so the answer matches the one Postgres gives for the same predicate
// on the same column, which is why each is decided by the column's DECLARED KIND and never by the
// JS type of whichever value is in hand: the database decides by the column's type, so a driver
// deciding by `typeof` is answering a different question.

import { compareDecimalText } from '@ultimat3/core';
import { keyOf } from './batch-read';
import { arrayContains, arrayOverlaps, jsonContains, jsonHasKey } from './containment';
import { kindOf, valueAt } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { searchInMemory } from './feature-errors';
import { instantMicros } from './instant';
import type { Predicate } from './tenancy';
import type { ColumnKind } from './types';

/**
 * The kinds whose ROW VALUE is a decimal string. `bigint()` and `decimal()` both hand back digits
 * as text on purpose (`columns-data.ts`): a JS `bigint` is what `JSON.stringify` throws on and a
 * `number` loses digits past 2^53, exactly where a legacy `int8` key lives.
 *
 * Which makes them the kinds no `typeof` branch can catch. `compare` had a `number`/`number` case
 * and a `bigint`/`bigint` case and neither fired for these, so both fell to
 * `String(left) < String(right)`: memory answered `["10","100","2","9"]` where Postgres answers
 * `["2","9","10","100"]`, and a keyset page boundary was cut where the database never cuts one.
 *
 * This SET is the whole of what this package contributes; the comparison itself is
 * `@ultimat3/core`'s `compareDecimalText`. The split is the point — the text arrives in more than
 * one package and the DECLARED KIND does not, so a caller with no column kinds
 * (`@ultimat3/query`, whose `OrderKey` is a name and a direction) deliberately never asks: a
 * `text` column holding `"10"` and `"9"` is ordered lexically by Postgres, and a comparator
 * guessing "both sides look like decimals" would trade this disagreement for that one.
 */
const DECIMAL_TEXT: ReadonlySet<ColumnKind> = new Set<ColumnKind>(['bigint', 'numeric']);

/** Absent and NULL are one thing to a predicate: a column the projection left out is not a value. */
const isNull = (value: unknown): boolean => value === null || value === undefined;

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
  if (kind !== undefined && DECIMAL_TEXT.has(kind)) {
    // `undefined` when either side is not a plain decimal — that pair is not a numeric comparison,
    // so it falls through to the branches below rather than being guessed at.
    const exact = compareDecimalText(left, right);
    if (exact !== undefined) return exact;
  }
  if (typeof left === 'number' && typeof right === 'number') return sign(left, right);
  if (typeof left === 'bigint' && typeof right === 'bigint') return sign(left, right);
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
  if (kind === 'uuid' && typeof left === 'string' && typeof right === 'string') {
    return keyOf('uuid', left) === keyOf('uuid', right);
  }
  return left === right;
};

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const quote = (text: string): string => text.replace(REGEX_SPECIAL, '\\$&');

/**
 * Postgres answers a `LIKE` pattern ending in the escape character with `22025 — LIKE pattern must
 * not end with escape character`, so a pattern that means nothing there means nothing here either.
 * The pattern itself is never echoed: a filter value is app data, and this cause is rendered into
 * a log line.
 */
const danglingEscape = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}: a like pattern ends with a backslash, which is the escape character — Postgres answers that pattern with 22025 (LIKE pattern must not end with escape character)`,
    fix: "double it — 'a\\\\' is the pattern that matches one literal backslash, and 'a\\%b' matches a literal %",
  });

/**
 * A SQL `LIKE` pattern as a regex, with Postgres' DEFAULT escape handling: `%` and `_` are the
 * wildcards, a backslash escapes either (or itself), and everything else is literal.
 *
 * The backslash used to be quoted for the regex BEFORE the wildcards were expanded, so `'a\%b'`
 * matched the literal `a%b` in Postgres and `a\<anything>b` here — one pattern, two meanings, and
 * the driver that disagreed was the one every test runs against.
 *
 * A RUN of `%` is still one `.*`, not one each: `%%%…x` compiled to twenty adjacent `.*` groups,
 * and an anchored regex with twenty of them takes exponential time to fail on a long value — a
 * filter value forwarded from a search box is then a CPU stall in the process. Postgres reads a run
 * of `%` as one wildcard too, so this is the two drivers agreeing rather than a defensive
 * narrowing.
 */
const likePattern = (entityName: string, pattern: string): RegExp => {
  let source = '';
  let at = 0;
  while (at < pattern.length) {
    const char = pattern[at];
    if (char === '\\') {
      const escaped = pattern[at + 1];
      if (escaped === undefined) throw danglingEscape(entityName);
      source += quote(escaped);
      at += 2;
      continue;
    }
    if (char === '%') {
      while (pattern[at] === '%') at += 1;
      source += '.*';
      continue;
    }
    source += char === '_' ? '.' : quote(char ?? '');
    at += 1;
  }
  return new RegExp(`^${source}$`, 's');
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
      return !unknown() && likePattern(entity.$name, String(predicate.value)).test(String(actual));
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
