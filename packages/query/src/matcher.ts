/**
 * The incremental matcher: given one change event, decide whether a live query's
 * result set moves and emit the minimal patch. Supported shapes are equality-ish
 * filters + orderBy + limit; anything else throws X_MATCHER_UNSUPPORTED, because
 * an honest refusal beats a silently wrong result set.
 */
import { MatcherUnsupportedError, QueryNotPageableError } from './errors';
import type { QueryShape } from './shape';
import { compareRows, matchesFilters, totalOrder } from './shape';
import { columnOf } from './stable';

export type ChangeOp = 'insert' | 'update' | 'delete';

export interface ChangeEvent<TRow extends object> {
  readonly entity: string;
  readonly op: ChangeOp;
  readonly row: TRow;
  /** Previous image, required for `update` to know whether the row was in the set. */
  readonly before?: TRow;
}

export type Patch<TRow extends object> =
  | { readonly kind: 'add'; readonly position: number; readonly row: TRow }
  | { readonly kind: 'update'; readonly position: number; readonly row: TRow }
  | { readonly kind: 'remove'; readonly position: number; readonly id: string }
  /**
   * The window lost a row and the tail is unknown to the client: ask the server
   * for rows from `from` onward. Only reachable for `limit`ed queries.
   */
  | { readonly kind: 'refill'; readonly from: number };

/** Filter operators the matcher can evaluate incrementally. */
const SUPPORTED_OPS = new Set(['=', '!=', 'in', '>', '>=', '<', '<=']);

export function assertMatchable(name: string, shape: QueryShape): void {
  if (shape.unsupported.length > 0) {
    throw new MatcherUnsupportedError(name, shape.unsupported.join(', '));
  }
  for (const filter of shape.filters) {
    if (!SUPPORTED_OPS.has(filter.op)) {
      throw new MatcherUnsupportedError(name, `filter operator "${filter.op}"`);
    }
  }
}

/**
 * `rows` is the subscriber's current, ordered result set. Patches apply in order.
 */
export function match<TRow extends object>(
  name: string,
  shape: QueryShape,
  rows: readonly TRow[],
  event: ChangeEvent<TRow>,
): readonly Patch<TRow>[] {
  assertMatchable(name, shape);
  if (event.entity !== shape.entity) return [];

  const id = idOf(event.row, shape.entity);
  const index = rows.findIndex((row) => idOf(row, shape.entity) === id);
  const inSet = index >= 0;
  const belongs = event.op !== 'delete' && matchesFilters(event.row, shape.filters);

  if (event.op === 'delete' || (inSet && !belongs)) {
    return inSet ? removeAt(shape, index, id, true) : [];
  }
  if (!belongs) return [];
  if (!inSet) return insert(shape, rows, event.row);

  // Present and still matching: a change to an ordering column is a move, not an update.
  const current = rows[index];
  const moved =
    shape.orderBy.length > 0 &&
    current !== undefined &&
    compareRows(event.row, current, shape.orderBy) !== 0;
  if (!moved) return [{ kind: 'update', position: index, row: event.row }];

  const without = [...rows.slice(0, index), ...rows.slice(index + 1)];
  // A move to the TAIL of a full window is a position only the server can fill. `insert()` places
  // the row among the `limit - 1` rows the client still holds, so its position can never reach
  // `shape.limit` and the `position >= shape.limit` bail below is unreachable on this path — the
  // row was re-inserted INSIDE the window. Proven with `limit: 3`, window `[a:1, b:2, c:3]` and a
  // server also holding `d:4, e:5`: moving `a` to `99` rendered `[b, c, a:99]` where the true
  // window is `[b, c, d]`. Whether the moved row is still in the window is the server's answer
  // too, so the refill covers both.
  const wasFull = shape.limit !== null && rows.length >= shape.limit;
  if (wasFull && positionFor(shape, without, event.row) >= without.length) {
    return removeAt<TRow>(shape, index, id, true);
  }
  return [...removeAt<TRow>(shape, index, id, false), ...insert(shape, without, event.row)];
}

function insert<TRow extends object>(
  shape: QueryShape,
  rows: readonly TRow[],
  row: TRow,
): readonly Patch<TRow>[] {
  const position = positionFor(shape, rows, row);
  // Sorted past the end of a full window: the row exists but nobody sees it.
  if (shape.limit !== null && position >= shape.limit) return [];
  const patches: Patch<TRow>[] = [{ kind: 'add', position, row }];
  if (shape.limit !== null && rows.length >= shape.limit) {
    const evicted = rows[shape.limit - 1];
    if (evicted !== undefined) {
      patches.push({ kind: 'remove', position: shape.limit, id: idOf(evicted, shape.entity) });
    }
  }
  return patches;
}

function removeAt<TRow extends object>(
  shape: QueryShape,
  index: number,
  id: string,
  refill: boolean,
): readonly Patch<TRow>[] {
  const patches: Patch<TRow>[] = [{ kind: 'remove', position: index, id }];
  // A limited window may now be one row short, and the tail lives on the server.
  if (refill && shape.limit !== null) patches.push({ kind: 'refill', from: shape.limit - 1 });
  return patches;
}

/**
 * Insertion index under the ordering the source serves — `totalOrder`, not the declared keys.
 *
 * A page arrives as `order by <declared keys>, "id" asc` and `isAfterKey` reads the next one the
 * same way, so a row tied on every declared key belongs where its id puts it. Placing it at the
 * end of the tie group instead is a position the database would never return: the client renders
 * one order, a re-read answers another, and the cursor cut from the window's tail skips the ties
 * the matcher pushed past it.
 *
 * An unordered query has no position to get wrong — SQL promises none — so it appends.
 */
export function positionFor<TRow extends object>(
  shape: QueryShape,
  rows: readonly TRow[],
  row: TRow,
): number {
  if (shape.orderBy.length === 0) return rows.length;
  const order = totalOrder(shape.orderBy);
  const found = rows.findIndex((current) => compareRows(row, current, order) < 0);
  return found === -1 ? rows.length : found;
}

/**
 * The row's identity, and the tiebreak `positionFor` sorts by. Refused when absent for the reason
 * `seekKeyOf` refuses it: `String(undefined)` is `"undefined"`, an id every id-less row shares, so
 * one row's patch lands on another's position and a `remove` names a row no client holds.
 */
function idOf(row: object, entity: string): string {
  const value = columnOf(row, 'id');
  if (value === undefined || value === null) throw new QueryNotPageableError(entity);
  return typeof value === 'string' ? value : String(value);
}
