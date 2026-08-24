// Single responsibility: turn the TEXT an aggregate statement returns into the value the column's
// kind holds — the Postgres driver's half of `aggregate.ts`, opposite `aggregate-fold.ts`.
//
// The statement casts every aggregate to `::text` on purpose. `sum(bigint)` is a `numeric` the
// client hands back as a string anyway, `min(timestamptz)` would arrive as a millisecond `Date`,
// and pinning all of them to text means exactly one place decides what the value becomes.

import type { AggregateFn } from './aggregate';
import type { ColumnKind } from './types';

/**
 * `sum` and `avg` stay decimal TEXT whatever the column was, and that is the point: the sum of a
 * million `integer` rows is not an `integer`, `Number()` on it loses digits past 2^53, and a
 * binary float loses cents on a `numeric`. A caller who wants a JS number writes the `Number()`
 * themselves, where the loss is a decision somebody made.
 *
 * `min` and `max` answer the ROW's own type, because the answer is one of the values that went in:
 * a `timestamptz` back to a `Date` (the row property's type), everything else to the text it
 * already is — `integer` becomes a `number` because that is what the row holds, and a minimum
 * cannot exceed a value that already fitted in one.
 */
export const decodeAggregate = (fn: AggregateFn, kind: ColumnKind, text: string): unknown => {
  // Decided by the FUNCTION first: `min('likeCount')` is one of the rows' own values and fits in
  // whatever they fit in, while `sum('likeCount')` over a million of them does not.
  if (fn === 'sum' || fn === 'avg') return text;
  if (kind === 'timestamptz') {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (kind === 'integer') {
    const value = Number(text);
    return Number.isFinite(value) ? value : text;
  }
  return text;
};
