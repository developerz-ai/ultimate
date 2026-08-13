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

/**
 * SQL NULL, as a row spells it. A column the row simply omits reads `undefined` here and NULL
 * in Postgres, so both are the same absence — otherwise a fixture row without `deletedAt` and
 * the same row round-tripped through a driver answer `where({ deletedAt: null })` differently.
 */
export function isNull(value: unknown): boolean {
  return value === null || value === undefined;
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
    case '>=':
    case '<':
    case '<=':
      return ordered(filter.op, actual, filter.value);
    default:
      return false;
  }
}

/**
 * `col > NULL` is unknown in SQL and unknown is not a match, so a NULL on either side of an
 * ordering operator matches nothing here either. Only `=`, `!=` and `in` read NULL as a value —
 * and those are exactly the three `Builder.toSQL()` compiles to `is null` / `is distinct from`.
 */
function ordered(op: '>' | '>=' | '<' | '<=', actual: unknown, value: unknown): boolean {
  if (isNull(actual) || isNull(value)) return false;
  const result = compareValues(actual, value);
  switch (op) {
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
  }
}

/**
 * Dates compare by instant, everything else by value. No coercion across types.
 *
 * NULL is greater than every value and equal to itself — Postgres' own sort rule, which is what
 * lets `Builder.toSQL()` write it down as `asc nulls last` / `desc nulls first` and mean this
 * function. Sorting only: a comparison *filter* against NULL matches nothing (`ordered`). Before
 * this, `null` sorted as the string `"null"`, so it landed between `"m"` and `"o"` in memory and
 * at the end in the database — the same page read two ways.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (isNull(a) || isNull(b)) return isNull(a) ? (isNull(b) ? 0 : 1) : -1;
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
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
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
