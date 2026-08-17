// Single responsibility: what a sort value becomes inside a cursor, and what it becomes again on
// the way out. The codec is `@ultimat3/core`'s and it is JSON, so a `Date` went in and an ISO
// STRING came back: `isAfterKey` then compared `"1769904000000"` against `"2026-02-01T…"` through
// `compareValues`' string branch and page two came back empty. A `bigint` was worse — a bare
// `TypeError` out of `JSON.stringify`, with no code and no fix.
//
// `@ultimat3/entity`'s `cursor.ts` solves the same problem by reading the column's declared kind.
// A `query` has no column kinds — `QueryShape.orderBy` is a name and a direction — so the value
// carries its own tag instead. Self-describing, which is also what makes the revive total: nothing
// here has to know which read minted the cursor.

import { CursorValueUnsupportedError } from './errors';

/** The two tagged forms. `$x` is a key no column value can collide with: JSON has no bigints. */
const DATE = 'date';
const BIGINT = 'bigint';

interface TaggedValue {
  readonly $x: typeof DATE | typeof BIGINT;
  readonly v: string;
}

function isTagged(value: unknown): value is TaggedValue {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as Record<string, unknown>)['$x'];
  return (
    (tag === DATE || tag === BIGINT) && typeof (value as Record<string, unknown>)['v'] === 'string'
  );
}

/**
 * One sort value, in a form `JSON.stringify` carries losslessly.
 *
 * `undefined` becomes `null` because SQL has one absence and `isNull` reads both as it — a key
 * that encoded `undefined` would be dropped by `JSON.stringify` and shift every later key one
 * position left, which is a cursor that seeks by the wrong column.
 *
 * Everything JSON cannot carry AND this cannot tag is refused HERE, where the cursor is minted:
 * the mistake is the read's `orderBy`, and reporting it on the next request would blame a client
 * for a declaration it never saw.
 */
export function serializeSortValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CursorValueUnsupportedError('an Invalid Date');
    return { $x: DATE, v: value.toISOString() } satisfies TaggedValue;
  }
  if (typeof value === 'bigint') return { $x: BIGINT, v: value.toString() } satisfies TaggedValue;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  // `NaN` and `±Infinity` are `null` in JSON, which is the largest value in this framework's sort
  // order — so an unsortable number would decode as "past every row" and end the listing.
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new CursorValueUnsupportedError(`the number ${String(value)}`);
  }
  throw new CursorValueUnsupportedError(`a ${typeof value}`);
}

/** The inverse, over a whole decoded key. A value that is not one of ours is handed back as is. */
export function reviveSortKey(key: readonly unknown[]): readonly unknown[] {
  return key.map((value) => {
    if (!isTagged(value)) return value;
    return value.$x === DATE ? new Date(value.v) : BigInt(value.v);
  });
}
