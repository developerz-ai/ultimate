// Single responsibility: a JS array bound as a statement parameter, rendered as the Postgres array
// literal `Bun.SQL` does not render.
//
// WHAT IS BROKEN WITHOUT IT. `Bun.SQL`'s positional form serialises an array by JOINING ITS
// ELEMENTS WITH COMMAS, so `unsafe('select $1::text[]', [['x', 'y']])` sends the string `x,y` and
// Postgres answers `malformed array literal: "x,y"` (SQLSTATE 22P02). Measured on Bun 1.4.0
// against Postgres 17. Three shipped statements bound an array through that path and every one
// of them failed — `SQL_CLAIM` (the worker's claim loop), `SQL_OUTBOX_RELEASE` and
// `SQL_NOTIFY_INBOX_MARK_READ`. Issue #384.
//
// WHY HERE AND NOT AT THE THREE CALL SITES. `sendOn` is the one place this driver's `unsafe` is
// called, so one encoder here is every caller fixed and none of them has to remember — a helper
// each site imports is three chances to forget and a fourth site tomorrow that does. Axiom 1.
//
// WHY PGLITE IS UNTOUCHED. `pglite.ts` is a separate driver with its own `send`, and it encodes an
// array parameter correctly already — which is exactly why nothing caught this: `x dev` runs the
// embedded default, so the framework's own dev loop is systematically blind to a defect that only
// appears once `DATABASE_URL` selects `Bun.SQL`. A container is where it bites.

import { assert } from '@ultimat3/core';

/**
 * One element, quoted only when it has to be.
 *
 * `NULL` unquoted is the array NULL and `"NULL"` is the four-character string, so a JS `null`
 * MUST render bare and a string that happens to spell it must not. Everything else is quoted when
 * it holds a character the literal grammar reads as structure — a comma, a brace, a quote, a
 * backslash, or leading/trailing whitespace the parser would strip — plus the empty string, which
 * unquoted is not an element at all.
 */
function element(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  // A Date is ALWAYS quoted, even though an ISO-8601 instant carries no character the grammar
  // reads as structure. A timestamp element is conventionally quoted, and the alternative is a
  // rule that holds only while nothing ever renders a timestamp with a space in it.
  if (value instanceof Date) return `"${value.toISOString()}"`;
  const text = String(value);
  const structural = /[{},"\\\s]/.test(text) || text.length === 0 || text.toUpperCase() === 'NULL';
  if (!structural) return text;
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The array literal for one parameter: `{a,b,c}`, elements escaped.
 *
 * NESTED ARRAYS ARE RENDERED, not refused: Postgres reads `{{a,b},{c,d}}` as a 2-dimensional
 * array, and rendering one is strictly closer to right than sending `a,b,c,d`. Nothing in this
 * tree binds one today.
 *
 * A RAGGED nest is REFUSED, never rendered. Postgres has no jagged array — every extent of a
 * dimension must match — and `{{a,b},{c}}` is `22P02 malformed array literal`, measured on 17
 * beside the rectangular `{{a,b},{c,d}}` that parses (`array-parameter.live.test.ts`). So a
 * literal this function is willing to emit is one the server is willing to read: rendering the
 * jagged one puts the fault two layers away, in the driver's words, naming neither the parameter
 * nor which row is short. `X_INVARIANT` through core's `assert`, the code this package already
 * borrows for a value this build cannot honour (`createIndex`'s unique GIN, `generatedClause`'s
 * generated-and-defaulted column).
 */
export function pgArrayLiteral(values: readonly unknown[]): string {
  const nested = values.filter((value): value is readonly unknown[] => Array.isArray(value));
  // Mixed depth is ragged too — `{a,{b,c}}` is a scalar beside a dimension, which Postgres reads
  // as the same malformed literal. Comparing counts alone would let it through.
  assert(
    nested.length === 0 || nested.length === values.length,
    'a nested array parameter mixes scalars and arrays at one level, and Postgres has no such array',
    'bind one array of scalars, or one array whose every element is an array of equal length',
  );
  const width = nested[0]?.length;
  assert(
    nested.every((row) => row.length === width),
    `a nested array parameter is ragged — its rows are ${nested.map((row) => row.length).join(', ')} long, and Postgres has no jagged array`,
    'give every row the same length, or bind one array per row',
  );
  return `{${values.map((value) => (Array.isArray(value) ? pgArrayLiteral(value) : element(value))).join(',')}}`;
}

/**
 * Every parameter of one statement, arrays rendered and everything else passed through untouched.
 *
 * A NEW ARRAY ONLY WHEN SOMETHING CHANGED. Every statement the framework runs goes through this
 * function, and almost none of them binds an array — so the common path is one `some` over a short
 * list and the caller's own array object, byte for byte, which is what `sendOn` had before this
 * existed (axiom 6).
 *
 * A `Uint8Array` is BYTEA and is deliberately not an array here: `Array.isArray` answers `false`
 * for a typed array, which is the behaviour this relies on rather than a special case it writes.
 */
export function encodeArrayParameters(values: readonly unknown[]): readonly unknown[] {
  if (!values.some(Array.isArray)) return values;
  return values.map((value) => (Array.isArray(value) ? pgArrayLiteral(value) : value));
}
