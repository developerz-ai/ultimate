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
import { column } from './column';
import { invariantViolated } from './errors';
import type { AnyColumn, Column, ColumnMeta } from './types';

const reject = (rule: string, detail: string): never => {
  throw invariantViolated('column', rule, detail);
};

/** The rejected value as its SHAPE, never its content — `columns.ts` explains why at length. */
const got = (value: unknown): string => `got ${describeValue(value)}`;

/**
 * A `jsonb` column whose CONTENTS are validated. The schema is required and that is the point: a
 * `json()` returning `unknown` is the `any` hole this framework forbids, and a column is the worst
 * place for one — the value arrives from the DATABASE as often as from a caller, so the row type
 * would be a claim nothing ever checked.
 *
 * The object is bound as an object, never as a string: a JSON string parameter is stored as a JSON
 * *string* by Postgres (measured — `'{"a":1}'` comes back as the text, not the object), so
 * stringifying here would change the value's type in the table.
 */
export const json = <T>(schema: StandardSchemaV1<unknown, T>): Column<T> =>
  column<T>('jsonb', (value) => {
    const result = validate(schema, value);
    if (result.issues === undefined) return result.value;
    // The ISSUES, never the value: `formatIssues` renders path + message, and a column rejection
    // reaches the caller and the log line where a value has no key left to redact.
    return reject(
      'json',
      `does not match the column's schema — ${formatIssues(result.issues).join('; ')}`,
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
        : reject(
            'bigint',
            `${String(value)} is past ±2^53, where a JS number is no longer exact — pass the digits as a string`,
          );
    }
    return typeof value === 'string' && DIGITS.test(value)
      ? value
      : reject('bigint', `expected whole digits, ${got(value)}`);
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
    reject('numeric', 'precision and scale are declared together — numeric(18, 8), or neither');
  }
  if (precision !== undefined && scale !== undefined) {
    if (!Number.isInteger(precision) || precision < 1 || precision > 1000) {
      reject('numeric', `precision must be 1..1000, ${got(precision)}`);
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
      reject('numeric', `scale must be 0..precision, ${got(scale)}`);
    }
  }
  const shape = /^-?\d+(\.\d+)?$/;
  return column<string>(
    'numeric',
    (value) => {
      const text = typeof value === 'number' ? decimalOfNumber(value) : value;
      if (typeof text !== 'string' || !shape.test(text)) {
        return reject('numeric', `expected a decimal number, ${got(value)}`);
      }
      const digits = text.replace('-', '').split('.');
      const fraction = digits[1]?.length ?? 0;
      if (scale !== undefined && fraction > scale) {
        return reject(
          'numeric',
          `${text} has ${fraction} decimal places and the column stores ${scale} — Postgres would round it, silently`,
        );
      }
      if (
        precision !== undefined &&
        (digits[0] ?? '').replace(/^0+(?=\d)/, '').length > precision - (scale ?? 0)
      ) {
        return reject('numeric', `${text} does not fit numeric(${precision}, ${scale ?? 0})`);
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
        ? reject('date', `expected a calendar date, ${got(value)}`)
        : plainDateUtc(value);
    }
    return isPlainDate(value)
      ? value
      : reject('date', `expected a YYYY-MM-DD calendar date, ${got(value)}`);
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
      return reject('bytea', `expected bytes, ${got(value)}`);
    }
    // Already the plain form: the overwhelmingly common case, and it costs one prototype read.
    return Object.getPrototypeOf(value) === Uint8Array.prototype ? value : new Uint8Array(value);
  });

/**
 * `<element>[]` — a Postgres array of a SCALAR column. The element is a column, so its own
 * `$parse` decides every member: `arrayOf(text({ max: 40 }))` refuses a 41-character tag exactly
 * where a `text()` column would.
 *
 * Money and arrays of arrays are refused rather than approximated: money is three physical columns
 * and cannot be one array element, and a nested array has no unambiguous literal form.
 */
export const arrayOf = <T>(element: Column<T>): Column<readonly T[]> => {
  const kind = element.$meta.kind;
  if (kind === 'money' || kind === 'array') {
    reject(
      'array',
      `arrayOf(${kind}) has no single column behind it — an array element is one scalar column`,
    );
  }
  return column<readonly T[]>(
    'array',
    (value) => {
      if (!Array.isArray(value)) return reject('array', `expected an array, ${got(value)}`);
      return value.map((member) => element.$parse(member));
    },
    { element: element as AnyColumn },
  );
};

/** The element's own kind, for the projections that need the physical type. */
export const elementMeta = (meta: ColumnMeta): ColumnMeta | undefined => meta.element?.$meta;
