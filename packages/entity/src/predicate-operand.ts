// Single responsibility: a comparison operand, normalised or refused by the column's DECLARED KIND,
// ONCE for both drivers. `memory-match.ts` and `pg-sql.ts` each call `operandFor` before they read
// the operand, so an operand whose meaning would depend on the driver never reaches either of them:
// it is spelled one way, or it is refused with the same code in both.

import { renderFixLiteral } from '@ultimat3/core';
import { plainDateUtc } from '@ultimat3/time';
import { got } from './column-values';
import { kindOf } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { instantMicros } from './instant';
import { isNullish as isNull } from './is-null';
import type { Predicate } from './tenancy';
import type { ColumnKind } from './types';

/** The operators whose operand is compared to the column's value as a value of its kind. */
const COMPARING: ReadonlySet<string> = new Set(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte']);

/** Postgres has no `like` for these: `integer ~~ unknown` is "operator does not exist". */
const NUMERIC_KINDS: ReadonlySet<ColumnKind | undefined> = new Set<ColumnKind | undefined>([
  'integer',
  'bigint',
  'numeric',
]);

/** What an `int4`/`int8` parameter parses: digits with a sign, surrounding blanks allowed. */
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;

/** A digit string is a cursor's MICROSECOND count to `instantMicros`, and no instant to Postgres. */
const DIGITS = /^\s*-?\d+\s*$/;

const refused = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  detail: string,
  fix: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name}.${predicate.column} ${predicate.op}: ${detail}`,
    fix,
  });

/** ISO text with no zone: a calendar date, or a date and a wall time. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/**
 * An instant operand is a `Date` or ISO text, read in ONE zone by both drivers. Zoneless text
 * (`'2026-01-01'`, `'2026-01-01T10:00'`) is read as UTC and handed on with its `Z`, so Postgres
 * never reads it in a session `TimeZone` this process cannot know, and memory compares instants,
 * never a `Date`'s text against the operand's (which matched every row). A number is refused: epoch
 * milliseconds bind as digits, which Postgres parses as no instant.
 */
const instantOperand = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  value: unknown,
): unknown => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && !DIGITS.test(value)) {
    const text = value.trim();
    // A calendar date is its midnight; a wall time without seconds gains `:00`: the instant
    // reader asks for both.
    const zoned = ZONELESS.test(text)
      ? `${text.replace(' ', 'T')}${text.length === 10 ? 'T00:00:00' : text.length === 16 ? ':00' : ''}Z`
      : value;
    if (instantMicros(zoned) !== undefined) return zoned;
  }
  throw refused(
    entity,
    predicate,
    `expected an instant — a Date or ISO-8601 text — ${got(value)}`,
    `.andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, '${predicate.op}', new Date('2026-01-01T00:00:00Z'))   // ISO text without a zone is read as UTC; a calendar date is a date() column`,
  );
};

/**
 * A `Date` against a `date()` column is the calendar date it holds in UTC — `plainDateUtc`, the
 * conversion the column's own `$parse` makes on write. Memory compared the `Date` to the stored
 * `YYYY-MM-DD` as text; Postgres casts it. One spelling, so both compare the same two dates.
 */
const dateOperand = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  value: unknown,
): unknown => {
  if (!(value instanceof Date)) return value;
  if (!Number.isNaN(value.getTime())) return plainDateUtc(value);
  throw refused(
    entity,
    predicate,
    `expected a calendar date, ${got(value)}`,
    `.andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, '${predicate.op}', '2026-08-22')   // a YYYY-MM-DD string or a valid Date`,
  );
};

/**
 * An `integer()`/`bigint()` operand is not a fraction. Postgres binds it as the column's type and
 * fails `1.5` (`X_DB_STATEMENT_FAILED`, a 500) where memory answered rows; refusing here is the one
 * answer both can give, and the caller is the one who knows whether `1.5` meant `1` or `2`.
 */
const integerOperand = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  value: unknown,
): unknown => {
  // A NUMBER the text spells (`'1.5'`, `'1e1'`) is the same fraction; text that is no number at
  // all is left as written, so Postgres answers its own refusal (`keyOf`'s rule, `batch-read.ts`).
  const fraction =
    typeof value === 'number'
      ? !Number.isInteger(value)
      : typeof value === 'string' &&
        !INTEGER_TEXT.test(value) &&
        value.trim() !== '' &&
        Number.isFinite(Number(value));
  if (!fraction) return value;
  throw refused(
    entity,
    predicate,
    `expected a whole number for an integer column, ${got(value)}`,
    `.andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, '${predicate.op}', Math.ceil(value))   // or Math.floor — pick the bound the fraction meant; the column holds whole numbers`,
  );
};

const scalarOperand = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  kind: ColumnKind | undefined,
  value: unknown,
): unknown => {
  if (isNull(value)) return value;
  if (kind === 'timestamptz') return instantOperand(entity, predicate, value);
  if (kind === 'date') return dateOperand(entity, predicate, value);
  if (kind === 'integer' || kind === 'bigint') return integerOperand(entity, predicate, value);
  return value;
};

/**
 * The predicate with its operand in the one form both drivers read, or a refusal. Every operator
 * outside the comparing set passes through untouched — containment, NULL tests and search have
 * their own rules (`containment.ts`, `is-null.ts`, `search.ts`).
 */
export const operandFor = <Row>(entity: EntityCore<Row>, predicate: Predicate): Predicate => {
  const kind = kindOf(entity, predicate.column);
  if (predicate.op === 'like' && NUMERIC_KINDS.has(kind)) {
    throw refused(
      entity,
      predicate,
      `like matches text, and this column is ${String(kind)}`,
      `.andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, 'gte', 100).andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, 'lt', 200)   // a number is matched by range, never by pattern`,
    );
  }
  if (!COMPARING.has(predicate.op)) return predicate;
  const value =
    predicate.op === 'in' && Array.isArray(predicate.value)
      ? predicate.value.map((each: unknown) => scalarOperand(entity, predicate, kind, each))
      : scalarOperand(entity, predicate, kind, predicate.value);
  return value === predicate.value ? predicate : { ...predicate, value };
};
