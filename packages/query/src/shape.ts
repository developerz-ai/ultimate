/**
 * The read vocabulary shared by the matcher, the SQL sources, pagination and the
 * live descriptor. Types only plus two pure predicates — no I/O lives here.
 */
import { QueryNotPageableError } from './errors';
import { columnOf } from './stable';

export type FilterOp = '=' | '!=' | 'in' | '>' | '>=' | '<' | '<=';

export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value: unknown;
}

export interface OrderKey {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * The statically-known shape of a read. The incremental matcher works from this,
 * never from SQL text — parsing SQL back is how frameworks get patches wrong.
 */
export interface QueryShape {
  readonly entity: string;
  readonly filters: readonly Filter[];
  readonly orderBy: readonly OrderKey[];
  readonly limit: number | null;
  /** Features present in the query that the matcher cannot patch incrementally. */
  readonly unsupported: readonly string[];
}

/** Where a page resumes: the sort-key values of the last row plus its id tiebreak. */
export interface SeekKey {
  readonly key: readonly unknown[];
  readonly id: string;
}

/**
 * Sort-key values of a row under an ordering, with its id as the final tiebreak.
 *
 * A row with no `id` is refused rather than stringified: `String(undefined)` is `"undefined"`,
 * which every row in the result set then matches, so the cursor names a position that is both
 * signed and meaningless. The tiebreak is what makes the order total — without it two rows
 * sharing a sort value straddle a page boundary and one of them is lost.
 */
export function seekKeyOf(
  row: object,
  shape: { readonly orderBy: readonly OrderKey[]; readonly entity?: string },
): SeekKey {
  const id = columnOf(row, 'id');
  if (id === undefined || id === null) throw new QueryNotPageableError(shape.entity);
  return {
    key: shape.orderBy.map((order) => columnOf(row, order.column)),
    id: typeof id === 'string' ? id : String(id),
  };
}

export function matchesFilters(row: object, filters: readonly Filter[]): boolean {
  return filters.every((filter) => matchesFilter(row, filter));
}

export function matchesFilter(row: object, filter: Filter): boolean {
  const actual = columnOf(row, filter.column);
  switch (filter.op) {
    case '=':
      return same(actual, filter.value);
    case '!=':
      return !same(actual, filter.value);
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((item) => same(actual, item));
    case '>':
      return compareValues(actual, filter.value) > 0;
    case '>=':
      return compareValues(actual, filter.value) >= 0;
    case '<':
      return compareValues(actual, filter.value) < 0;
    case '<=':
      return compareValues(actual, filter.value) <= 0;
    default:
      return false;
  }
}

/** Dates compare by instant, everything else by value. No coercion across types. */
export function compareValues(a: unknown, b: unknown): number {
  const left = normalize(a);
  const right = normalize(b);
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const l = String(left);
  const r = String(right);
  return l < r ? -1 : l > r ? 1 : 0;
}

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function same(a: unknown, b: unknown): boolean {
  return compareValues(a, b) === 0 && typeof normalize(a) === typeof normalize(b);
}

/** Row ordering under an `orderBy` list. Stable, and total when an id key is last. */
export function compareRows(a: object, b: object, orderBy: readonly OrderKey[]): number {
  for (const key of orderBy) {
    const result = compareValues(columnOf(a, key.column), columnOf(b, key.column));
    if (result !== 0) return key.direction === 'asc' ? result : -result;
  }
  return 0;
}
