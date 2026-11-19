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
import { instantCrosses, instantMicros } from './instant';
import { isNullish as isNull } from './is-null';
import type { Predicate } from './tenancy';
import type { ColumnKind } from './types';
import { canonicalUuid } from './uuid-text';

/** The operators whose operand is compared to the column's value as a value of its kind. */
const COMPARING: ReadonlySet<string> = new Set(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte']);

/**
 * Postgres has no `like` for these: `integer ~~ unknown`, `uuid ~~ unknown`, `boolean ~~ unknown`
 * are each "operator does not exist" (`42883`), where memory matched the value's text. `bytea` is
 * NOT here: the server has a `bytea ~~ bytea`, so that call answers today and stays answered.
 */
const NO_LIKE_KINDS: ReadonlySet<ColumnKind | undefined> = new Set<ColumnKind | undefined>([
  'integer',
  'bigint',
  'numeric',
  'uuid',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
  'array',
]);

const NUMERIC_KINDS: ReadonlySet<ColumnKind | undefined> = new Set<ColumnKind | undefined>([
  'integer',
  'bigint',
  'numeric',
]);

/** Postgres binds at most this many parameters in one statement (`bulk-write.ts` holds the same). */
const MAX_BINDS = 65_535;

/**
 * An `in` list longer than this crosses as ONE array parameter (`pg-sql-in.ts`). Half the bind
 * budget: every list a statement could carry before still compiles to the `in (…)` it always did,
 * and one past the budget — `08P01`, or a dropped connection — now answers.
 */
export const IN_LIST_AS_ARRAY_FROM = 32_768;

/**
 * The kinds whose `in` list has an array form: each element's text is what the same value bound
 * alone parses to (proved per kind, `predicate-operand.test.ts`). `bytea`, `jsonb` and an array
 * column have no element literal (`arrayElement`, `pg-row.ts`).
 */
const ARRAY_BOUND_KINDS: ReadonlySet<ColumnKind | undefined> = new Set<ColumnKind | undefined>([
  'uuid',
  'text',
  'char',
  'boolean',
  'integer',
  'bigint',
  'numeric',
  'timestamptz',
  'date',
]);

export const bindsAsArray = (kind: ColumnKind | undefined, length: number): boolean =>
  length >= IN_LIST_AS_ARRAY_FROM && ARRAY_BOUND_KINDS.has(kind);

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
  if (value instanceof Date && instantCrosses(value)) return value;
  // Year 0000 is no year to Postgres (`22008`), whatever the offset beside it.
  if (typeof value === 'string' && !DIGITS.test(value) && !value.trim().startsWith('0000-')) {
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
    `expected an instant — a Date or ISO-8601 text, in years 0001–9999 — ${got(value)}`,
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
  // Every spelling Postgres parses to the same sixteen bytes is ONE operand: memory compared the
  // text, so a braced or unhyphenated id matched there and nowhere else. Text that is no uuid is
  // left as written — `operandFor` decides what it means for the operators that have an answer.
  if (kind === 'uuid') return canonicalUuid(value) ?? value;
  return value;
};

/**
 * A non-null operand no value of the column's kind can EQUAL: text that is not a uuid, against a
 * `uuid()` column. Postgres refused the parameter itself (`22P02`, a 500 for an id out of a URL)
 * where memory answered "no such row"; both now give memory's answer. `pg-sql.ts` asks this for
 * `neq`, the one operator the rewrite below cannot spell.
 */
export const equalsNoValue = (kind: ColumnKind | undefined, value: unknown): boolean =>
  kind === 'uuid' && !isNull(value) && canonicalUuid(value) === undefined;

const inList = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  kind: ColumnKind | undefined,
  list: readonly unknown[],
): readonly unknown[] => {
  const operands = list
    .map((each: unknown) => scalarOperand(entity, predicate, kind, each))
    .filter((each) => !equalsNoValue(kind, each));
  if (operands.length <= MAX_BINDS || ARRAY_BOUND_KINDS.has(kind)) return operands;
  throw refused(
    entity,
    predicate,
    `${String(operands.length)} values is more than one statement binds (${String(MAX_BINDS)}), and a ${String(kind)} column has no array form to send them as`,
    `for (let at = 0; at < values.length; at += 10_000) await ${entity.$name}.andWhere(${renderFixLiteral(predicate.column, "'<column>'")}, 'in', values.slice(at, at + 10_000)).all()   // one statement per slice`,
  );
};

/**
 * The predicate with its operand in the one form both drivers read, or a refusal. Every operator
 * outside the comparing set passes through untouched — containment, NULL tests and search have
 * their own rules (`containment.ts`, `is-null.ts`, `search.ts`).
 */
export const operandFor = <Row>(entity: EntityCore<Row>, predicate: Predicate): Predicate => {
  const kind = kindOf(entity, predicate.column);
  if (predicate.op === 'like' && NO_LIKE_KINDS.has(kind)) {
    const column = renderFixLiteral(predicate.column, "'<column>'");
    throw refused(
      entity,
      predicate,
      `like matches text, and this column is ${String(kind)}`,
      NUMERIC_KINDS.has(kind)
        ? `.andWhere(${column}, 'gte', 100).andWhere(${column}, 'lt', 200)   // a number is matched by range, never by pattern`
        : `.andWhere(${column}, 'eq', value)   // like reads a text() or char() column; a ${String(kind)} is compared as a value — eq, in, or a gte/lt range`,
    );
  }
  if (!COMPARING.has(predicate.op)) return predicate;
  if (predicate.op === 'in' && Array.isArray(predicate.value)) {
    return { ...predicate, value: inList(entity, predicate, kind, predicate.value) };
  }
  const value = scalarOperand(entity, predicate, kind, predicate.value);
  // `eq` against a value nothing equals is the empty list both drivers already answer no row for.
  if (predicate.op === 'eq' && equalsNoValue(kind, value)) {
    return { ...predicate, op: 'in', value: [] };
  }
  return value === predicate.value ? predicate : { ...predicate, value };
};
