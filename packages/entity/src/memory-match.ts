// Single responsibility: what a `Predicate` MEANS in the in-memory driver — equality, ordering and
// LIKE. Every rule here exists so the answer matches the one Postgres gives for the same predicate
// on the same column, which is why each is decided by the column's DECLARED KIND and never by the
// JS type of whichever value is in hand: the database decides by the column's type, so a driver
// deciding by `typeof` is answering a different question.

import { compareDecimalText } from '@ultimat3/core';
import { keyOf } from './batch-read';
import { kindOf, valueAt } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
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
  // The column's declared kind, resolved once — `price.minor` included, which is the path a money
  // predicate and a money sort key both name.
  const kind = kindOf(entity, predicate.column);
  const actual = valueAt(row, predicate.column);
  const same = (candidate: unknown): boolean => sameValueOfKind(kind, actual, candidate);
  const order = (): number => compareByKind(kind, actual, predicate.value);
  switch (predicate.op) {
    case 'eq':
      return same(predicate.value);
    case 'neq':
      return !same(predicate.value);
    // `in` reads a LIST or nothing: an operand that is not an array matches no row, which is what
    // `predicateSql` now compiles it to and what `@ultimat3/query` answers for the same operand.
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some(same);
    case 'gt':
      return order() > 0;
    case 'gte':
      return order() >= 0;
    case 'lt':
      return order() < 0;
    case 'lte':
      return order() <= 0;
    // Real LIKE semantics, so `'draft%'` means "starts with" here exactly as it does in Postgres.
    // Treating the pattern as a substring would make the two drivers disagree.
    case 'like':
      return likePattern(entity.$name, String(predicate.value)).test(String(actual));
    case 'is-null':
      return actual === null || actual === undefined;
    case 'is-not-null':
      return actual !== null && actual !== undefined;
  }
};
