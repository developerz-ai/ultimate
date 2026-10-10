// Single responsibility: an `arrayOf()` cell as the driver handed it back -> the JS array its
// element column can parse. A driver decides PER TYPE OID and PER PROTOCOL what an array cell is,
// and the repository may not depend on that table:
//
//   * `Bun.SQL` parses the array types it knows and hands every other one back as its TEXT
//     literal — `uuid[]` is `'{01a1…,01a2…}'` (measured, Bun 1.4.2 against Postgres 17 and 18),
//     which `arrayOf(uuid())` refused as "expected an array, got a string" on every read while
//     PGlite, which `x dev` and every non-live suite run on, parsed it;
//   * `Bun.SQL` hands `int4[]` back as an `Int32Array` whenever the statement carries a parameter
//     (the extended protocol's binary result) and as an `Array` when it carries none.
//
// Neither is decided by a type-parser registration: `Bun.SQL` has none, and a table keyed by oid
// would miss the next type it does not know — a domain or an extension type has a per-database
// oid. The DECLARED column is the only thing that knows this cell is an array, so the literal is
// read here, keyed by the declaration and by nothing the driver says.

import { instantMicros } from './instant';
import { parsePgArray } from './pg-array-literal';
import type { ColumnKind, ColumnMeta } from './types';

const MICROS_PER_MILLI = 1000n;

/** Floor, so a pre-1970 instant with a sub-millisecond part lands on the millisecond below it. */
const millisOf = (micros: bigint): number => {
  const remainder = ((micros % MICROS_PER_MILLI) + MICROS_PER_MILLI) % MICROS_PER_MILLI;
  return Number((micros - remainder) / MICROS_PER_MILLI);
};

const WHOLE = /^-?\d+$/;

/**
 * One element's TEXT -> the value a driver that parsed the array would have handed over, which is
 * what each column's `$parse` was written against: a `number` for `integer`, a `boolean` for
 * `boolean`, a `Date` for `timestamptz`, and the text itself for every kind whose row value IS
 * text (`uuid`, `text`, `numeric`, `bigint`, `date`).
 *
 * A text this cannot read is returned AS IT IS, never coerced: the element column refuses it with
 * its own words, where `Number('abc')` would have stored a `NaN` nobody can find again.
 */
const elementOf = (kind: ColumnKind | undefined, raw: string): unknown => {
  switch (kind) {
    case 'integer':
      return WHOLE.test(raw) ? Number(raw) : raw;
    case 'boolean':
      return raw === 't' || raw === 'true' ? true : raw === 'f' || raw === 'false' ? false : raw;
    case 'timestamptz': {
      // `2026-01-02 03:04:05.123456+00`: Postgres names the offset, so the text is an instant.
      const micros = instantMicros(raw);
      return micros === undefined || WHOLE.test(raw) ? raw : new Date(millisOf(micros));
    }
    default:
      return raw;
  }
};

/** Every integer and float typed array; a `DataView` is bytes with no elements to list. */
const isTypedArray = (value: unknown): value is ArrayLike<unknown> =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

/** What `arrayFromDriver` answers when the cell is neither an array nor a literal of one. */
export const NOT_AN_ARRAY = Symbol('not-an-array');

/**
 * The cell of a column DECLARED `arrayOf()`, as a plain JS array of driver-shaped elements — or
 * `NOT_AN_ARRAY` when it is none of the three shapes a driver produces. Called for an array column
 * only: a string in a `text()` column is a string, and nothing here ever asks whether it "looks
 * like" a literal.
 *
 * A nested literal (`{{a,b},{c,d}}`) parses to nested arrays and is refused by the element column
 * one line later — `arrayOf()` declares one dimension, so a second one is the table disagreeing
 * with the entity, said by the column that knows its own type.
 */
export const arrayFromDriver = (
  meta: ColumnMeta,
  value: unknown,
): readonly unknown[] | typeof NOT_AN_ARRAY => {
  if (Array.isArray(value)) return value;
  if (isTypedArray(value)) return Array.from(value);
  if (typeof value !== 'string') return NOT_AN_ARRAY;
  const kind = meta.element?.$meta.kind;
  return parsePgArray(value, (raw) => elementOf(kind, raw)) ?? NOT_AN_ARRAY;
};
