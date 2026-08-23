// The column builders an EXISTING schema needs. `columns.ts` holds the opinionated set — one way
// to store an id, an instant, money — and every one of them is a decision this framework made for
// a table it was going to create. These are the shapes a table already has: a `jsonb` payload, a
// `numeric(18,8)` rate, a calendar `date`, an `int8` id past 2^53, a `bytea` blob, a `text[]`.
//
// Two rules run through all of them. A value crossing the driver is parsed by the column that
// declared it, because the two drivers disagree about what they hand back (`int8` is a string from
// Bun's `sql` and a `bigint` from PGlite — measured); and nothing here is an `any` hole, so `json()`
// takes a schema and validates through it.

import { describeValue, formatIssues, type StandardSchemaV1, validate } from '@ultimat3/schema';
import { isPlainDate, type PlainDate, plainDateUtc } from '@ultimat3/time';
import { arrayElementRefused, isRefusedElement } from './array-element';
import { column } from './column';
import { refuseColumn } from './refuse';
import type { AnyColumn, Column, ColumnMeta } from './types';

/** The rejected value as its SHAPE, never its content — `columns.ts` explains why at length. */
const got = (value: unknown): string => `got ${describeValue(value)}`;

/**
 * A `jsonb` column whose CONTENTS are validated. The schema is required and that is the point: a
 * `json()` returning `unknown` is the `any` hole this framework forbids, and a column is the worst
 * place for one — the value arrives from the DATABASE as often as from a caller, so the row type
 * would be a claim nothing ever checked.
 *
 * The value crosses to Postgres as TEXT and is cast back — `bindValues` calls `JSON.stringify` and
 * `cellCast` (`pg-sql.ts`) writes `::text::jsonb` — and both halves are load-bearing. The driver
 * seam refuses a plain object as a parameter (`X_SQL_UNSAFE`), so the object cannot cross as
 * itself; and under a bare `$1::jsonb` the server describes the parameter as `jsonb`, Bun's `sql`
 * JSON-ENCODES the string it was handed, and `{"a":1}` lands as a JSON *string* — `jsonb_typeof`
 * answers `string` (measured, Postgres 17.10). Pinning the parameter to `text` first is what makes
 * the server parse the characters, so neither half may be changed without the other.
 */
export const json = <T>(schema: StandardSchemaV1<unknown, T>): Column<T> =>
  column<T>('jsonb', (value) => {
    const result = validate(schema, value);
    if (result.issues === undefined) return result.value;
    // The ISSUES, never the value: `formatIssues` renders path + message, and a column rejection
    // reaches the caller and the log line where a value has no key left to redact.
    return refuseColumn(
      'json',
      `does not match the column's schema — ${formatIssues(result.issues).join('; ')}`,
      'correct the key the cause names, or widen the schema this column was declared with — json(t.object({ seats: t.number })) validates on the way in and on the way back',
    );
  });

const DIGITS = /^-?\d+$/;

/**
 * `bigint`, whose row type is a decimal STRING. Neither alternative survives contact:
 * a JS `bigint` is what `JSON.stringify` throws on — the reason `money.minor` is a `number` — and
 * a `number` silently loses digits past 2^53, which is precisely the range a legacy `int8` key or
 * a snowflake id lives in. A string holds every value the column can and crosses every wire this
 * framework generates.
 *
 * Both driver spellings arrive here and leave as one: Bun's `sql` returns `int8` as a string and
 * PGlite returns a `bigint`, and a row that meant two things by driver is the drift this package
 * exists to refuse.
 */
export const bigint = (): Column<string> =>
  column<string>('bigint', (value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
      return Number.isSafeInteger(value)
        ? String(value)
        : refuseColumn(
            'bigint',
            `${String(value)} is past ±2^53, where a JS number is no longer exact`,
            "quote the digits — bigint() takes and returns a decimal string, so pass '9007199254740993' rather than a number literal",
          );
    }
    return typeof value === 'string' && DIGITS.test(value)
      ? value
      : refuseColumn(
          'bigint',
          `expected whole digits, ${got(value)}`,
          'String(value) when it is already whole digits — a fractional value is decimal({ precision: 18, scale: 8 }) and an amount is money()',
        );
  });

export interface DecimalOptions {
  /** Emits `numeric(precision, scale)`. Both, or neither — a bare `numeric` is unbounded. */
  readonly precision?: number;
  readonly scale?: number;
}

/**
 * `numeric(p, s)`, whose row type is the exact decimal STRING Postgres returns. Money is the one
 * decimal this framework has an opinion about (integer minor units plus a currency, always); this
 * is every other one — a tax rate, an FX rate, a measurement — where the precision is the column's
 * and no JS number holds it.
 *
 * It is deliberately NOT arithmetic-friendly. A framework that handed back a float here would be
 * the float-money bug with a different name, and one that shipped a decimal type would be shipping
 * a numeric tower: the honest thing a driver already does is give you the digits.
 */
export const decimal = (options: DecimalOptions = {}): Column<string> => {
  const { precision, scale } = options;
  if ((precision === undefined) !== (scale === undefined)) {
    refuseColumn(
      'numeric',
      'precision and scale are declared together — numeric(18, 8), or neither',
      'decimal({ precision: 18, scale: 8 }) — both keys together, or decimal() for an unbounded numeric',
    );
  }
  if (precision !== undefined && scale !== undefined) {
    if (!Number.isInteger(precision) || precision < 1 || precision > 1000) {
      refuseColumn(
        'numeric',
        `precision must be 1..1000, ${got(precision)}`,
        'decimal({ precision: 18, scale: 8 }) — precision is the TOTAL digit count, from 1 to 1000',
      );
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
      refuseColumn(
        'numeric',
        `scale must be 0..precision, ${got(scale)}`,
        `decimal({ precision: ${precision}, scale: ${Math.min(2, precision)} }) — scale counts the digits AFTER the point and cannot exceed precision`,
      );
    }
  }
  const shape = /^-?\d+(\.\d+)?$/;
  return column<string>(
    'numeric',
    (value) => {
      const text = typeof value === 'number' ? decimalOfNumber(value) : value;
      if (typeof text !== 'string' || !shape.test(text)) {
        return refuseColumn(
          'numeric',
          `expected a decimal number, ${got(value)}`,
          "pass the digits as a string — decimal() holds an exact decimal, so write '1.25'; a float is taken only where String(value) is already exact",
        );
      }
      const digits = text.replace('-', '').split('.');
      const fraction = digits[1]?.length ?? 0;
      if (scale !== undefined && fraction > scale) {
        return refuseColumn(
          'numeric',
          `${text} has ${fraction} decimal places and the column stores ${scale} — Postgres would round it, silently`,
          `toFixed(${scale}) at the call site decides the rounding, or widen the column to decimal({ precision: ${(precision ?? fraction) + fraction - scale}, scale: ${fraction} }) and run x db gen "widen the numeric"`,
        );
      }
      const whole = (digits[0] ?? '').replace(/^0+(?=\d)/, '').length;
      if (precision !== undefined && whole > precision - (scale ?? 0)) {
        return refuseColumn(
          'numeric',
          `${text} does not fit numeric(${precision}, ${scale ?? 0})`,
          `widen the column — decimal({ precision: ${whole + (scale ?? 0)}, scale: ${scale ?? 0} }) — and run x db gen "widen the numeric": what overflows is the digits BEFORE the point`,
        );
      }
      return text;
    },
    precision === undefined || scale === undefined ? {} : { precision, numericScale: scale },
  );
};

/**
 * A float is accepted only where it is exactly representable as written — anything else is the
 * rounding this column exists to refuse, and refusing it at the write is the only place the caller
 * still knows what they meant.
 */
const decimalOfNumber = (value: number): string =>
  Number.isFinite(value) ? String(value) : 'not-a-number';

/**
 * A `date`: a calendar date, with no time and therefore no zone. The row type is
 * `@ultimat3/time`'s `PlainDate`, which is why this is not `timestamp()` with the clock zeroed —
 * `effective_on` is the date a rate applies, and stored as an instant it is a different date on
 * either side of midnight for half the planet.
 *
 * A driver hands a `date` column back as a `Date` at UTC midnight (measured: Bun's `sql` and
 * PGlite both), so that is the one conversion here, by its own name. The value written is the
 * string: binding a `Date` to a `date` parameter fails outright on a server whose client zone has
 * no name Postgres knows (`time zone "gmt-0500" not recognized`, measured on 17.10).
 */
export const date = (): Column<PlainDate> =>
  column<PlainDate>('date', (value) => {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? refuseColumn(
            'date',
            `expected a calendar date, ${got(value)}`,
            "pass a Date built from a real value — new Date('2026-08-22'); new Date(undefined) and a failed parse both produce the Invalid Date this refuses",
          )
        : plainDateUtc(value);
    }
    return isPlainDate(value)
      ? value
      : refuseColumn(
          'date',
          `expected a YYYY-MM-DD calendar date, ${got(value)}`,
          "pass '2026-08-22' or a Date — date() stores a calendar date with no clock and no zone; an instant is timestamp()",
        );
  });

/**
 * `bytea`. The row type is a plain `Uint8Array` and both drivers are normalised into one: Bun's
 * `sql` returns a `Buffer`, PGlite a `Uint8Array`, and the two serialise differently
 * (`{"type":"Buffer","data":[…]}` against `{"0":…}`) — so a row read through one driver and the
 * same row read through the other would not be the same object on any wire.
 */
export const bytes = (): Column<Uint8Array> =>
  column<Uint8Array>('bytea', (value) => {
    if (!(value instanceof Uint8Array)) {
      return refuseColumn(
        'bytea',
        `expected bytes, ${got(value)}`,
        "Buffer.from(value, 'base64') for base64 and new TextEncoder().encode(value) for text — bytes() stores a Uint8Array; a structured payload is json(schema)",
      );
    }
    // Already the plain form: the overwhelmingly common case, and it costs one prototype read.
    return Object.getPrototypeOf(value) === Uint8Array.prototype ? value : new Uint8Array(value);
  });

/**
 * `<element>[]` — a Postgres array of a SCALAR column. The element is a column, so its own
 * `$parse` decides every member: `arrayOf(text({ max: 40 }))` refuses a 41-character tag exactly
 * where a `text()` column would.
 *
 * Four element kinds are refused rather than approximated — see `arrayElementRefused`.
 */
export const arrayOf = <T>(element: Column<T>): Column<readonly T[]> => {
  const kind = element.$meta.kind;
  if (isRefusedElement(kind)) throw arrayElementRefused(kind);
  return column<readonly T[]>(
    'array',
    (value) => {
      if (!Array.isArray(value)) {
        return refuseColumn(
          'array',
          `expected an array, ${got(value)}`,
          'wrap it — [value] — or drop arrayOf() and declare the element column on its own when the table holds one scalar',
        );
      }
      return value.map((member) => element.$parse(member));
    },
    { element: element as AnyColumn },
  );
};

/** The element's own kind, for the projections that need the physical type. */
export const elementMeta = (meta: ColumnMeta): ColumnMeta | undefined => meta.element?.$meta;
