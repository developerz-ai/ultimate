/**
 * The incremental matcher: given one change event, decide whether a live query's
 * result set moves and emit the minimal patch. Supported shapes are equality-ish
 * filters + orderBy + limit; anything else throws X_MATCHER_UNSUPPORTED, because
 * an honest refusal beats a silently wrong result set.
 */
import { MatcherUnsupportedError } from './errors';
import type { QueryShape } from './shape';
import { compareRows, matchesFilters } from './shape';
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

  const id = idOf(event.row);
  const index = rows.findIndex((row) => idOf(row) === id);
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

  // A move keeps the window full, so it never needs a refill.
  const without = [...rows.slice(0, index), ...rows.slice(index + 1)];
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
      patches.push({ kind: 'remove', position: shape.limit, id: idOf(evicted) });
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

/** Insertion index under the query's ordering; append when the query is unordered. */
export function positionFor<TRow extends object>(
  shape: QueryShape,
  rows: readonly TRow[],
  row: TRow,
): number {
  if (shape.orderBy.length === 0) return rows.length;
  const found = rows.findIndex((current) => compareRows(row, current, shape.orderBy) < 0);
  return found === -1 ? rows.length : found;
}

function idOf(row: object): string {
  const value = columnOf(row, 'id');
  return typeof value === 'string' ? value : String(value);
}
