// Single responsibility: every value of one statement, encoded into what `Bun.SQL` sends correctly.
// Two kinds need it, both measured against Postgres 17: a JS array (`array-parameter.ts`, #384),
// and a `Date` once the pool runs unnamed statements (`prepare: false`, `bun-sql.ts`) — with no
// described type to go by the driver sent `Date.prototype.toString()`, a local-zone string
// Postgres refuses (`22007`), so every entity write carrying a timestamp failed.

import { instantText, pgArrayLiteral } from './array-parameter';

const needsEncoding = (value: unknown): boolean => Array.isArray(value) || value instanceof Date;

/**
 * A NEW ARRAY ONLY WHEN SOMETHING CHANGED — every statement in the process passes through here, so
 * the common path is one `some` and the caller's own array, byte for byte (axiom 6). A
 * `Uint8Array` is BYTEA, never an array: `Array.isArray` answers `false` for a typed array.
 *
 * It REFUSES what cannot be sent — a ragged array, an Invalid Date — with `X_INVARIANT`, so the
 * funnel calls it BEFORE the driver's `try`: inside it, a refusal was re-wrapped as a driver
 * failure and read "cannot reach the database".
 */
/**
 * The refusal alone, for a driver that does its own encoding. PGlite renders an array and a `Date`
 * correctly, so `pglite.ts` sends the caller's values untouched — but its serializer answers an
 * Invalid Date with the same bare `RangeError`, and the two funnels must refuse alike.
 */
export function refuseUnsendable(values: readonly unknown[]): void {
  for (const [index, value] of values.entries()) {
    if (value instanceof Date) instantText(value, index + 1);
  }
}

export function encodeBoundParameters(values: readonly unknown[]): readonly unknown[] {
  if (!values.some(needsEncoding)) return values;
  return values.map((value, index) => {
    if (Array.isArray(value)) return pgArrayLiteral(value);
    if (value instanceof Date) return instantText(value, index + 1);
    return value;
  });
}
