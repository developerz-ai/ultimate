// What a transition's decision READ, turned into the equality the compare-and-set also carries
// (#702): a row whose consulted columns changed between the read and the move matches no statement.
// Split from `transition.ts` because which columns can be pinned — and which cannot, honestly — is
// its own question, answered by the column's declared kind exactly as `memory-match.ts` answers one.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { isNullish } from './is-null';
import { sameValueOfKind } from './memory-match';
import type { ColumnKind } from './types';

/**
 * The evidence a decision about a move was made on: the row as it was read, and the properties the
 * decision consulted. `@ultimat3/action`'s `transition()` fills both — the row from its `row`
 * loader, `read` from what the policy touched — and a direct caller names its own.
 */
export interface TransitionObservation {
  readonly row: unknown;
  readonly read: readonly string[];
}

/**
 * The kinds whose `=` means one thing in both drivers for the value a READ hands back. Not the
 * others, and each for a measured reason: a `timestamptz` holds microseconds in Postgres and a
 * decoded `Date` milliseconds, so an equality pin on a `defaultNow()` column refuses every move
 * there and none in memory; `jsonb`, `array` and `bytea` compare structurally in neither driver's
 * `eq`; `money` is three physical columns. A sealed column is never pinned: its filter is refused.
 */
const PINNABLE: ReadonlySet<ColumnKind> = new Set<ColumnKind>([
  'uuid',
  'text',
  'char',
  'boolean',
  'integer',
  'bigint',
  'numeric',
  'date',
]);

/**
 * The property → value pairs to add to the move's predicate. Empty — the move exactly as before —
 * when there is no observation, when the observed row carries a key that is not THIS row's (a
 * loader may read a parent record, and pinning its values onto this one's columns would refuse
 * every move), or when nothing the decision read is a pinnable column. The key and the machine column are already in the
 * predicate, so they are skipped rather than pinned twice.
 */
export const pinsOf = <Row>(
  entity: EntityCore<Row>,
  key: string,
  machine: string,
  id: unknown,
  observed: TransitionObservation | undefined,
): Readonly<Record<string, unknown>> => {
  const row = observed?.row;
  if (observed === undefined || typeof row !== 'object' || row === null) return {};
  const values = row as Readonly<Record<string, unknown>>;
  // A row that NAMES another key is another record. One that names none is a projection of this
  // one (`select({ authorId: true })` — the loader is handed this row's id), and is pinned.
  const keyKind = columnFor(entity.$columns, key)?.$meta.kind;
  if (Object.hasOwn(values, key) && !sameValueOfKind(keyKind, values[key], id)) return {};
  const pins: Record<string, unknown> = {};
  for (const property of observed.read) {
    if (property === key || property === machine || !Object.hasOwn(values, property)) continue;
    const meta = columnFor(entity.$columns, property)?.$meta;
    if (meta === undefined || meta.sealed !== undefined || !PINNABLE.has(meta.kind)) continue;
    // `null` and never `undefined`: a pinned NULL is `is null` in both drivers, while an
    // `undefined` filter value is DROPPED by `namedColumns` — a pin that silently vanished.
    pins[property] = values[property] ?? null;
  }
  return pins;
};

/** Which pins the row as it stands now no longer satisfies — the diagnosis, never the decision. */
export const changedPins = <Row>(
  entity: EntityCore<Row>,
  row: unknown,
  pins: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const now = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  return Object.entries(pins)
    .filter(([property, was]) => {
      const is = now[property];
      if (isNullish(was) || isNullish(is)) return isNullish(was) !== isNullish(is);
      return !sameValueOfKind(columnFor(entity.$columns, property)?.$meta.kind, is, was);
    })
    .map(([property]) => property);
};
