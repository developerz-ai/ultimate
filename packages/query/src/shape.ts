/**
 * The read vocabulary shared by the matcher, the SQL sources, pagination and the
 * live descriptor: the types, and the two predicates that read a row. How two VALUES compare is
 * `@ultimat3/entity`'s answer (`compareByKind`, `sameValueOfKind`) — no comparator lives here.
 */
import type { ColumnKind } from '@ultimat3/entity';
import { compareByKind, sameValueOfKind } from '@ultimat3/entity';
import type { KindOf } from './column-kinds';
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

/**
 * Where a page resumes: the sort-key values of the last row plus its id tiebreak. `id` keeps the
 * row's own TYPE: a stringified numeric id compared lexically against the next page's rows, so
 * `"10" < "7"` and a row tied on the sort key after id 7 was never served.
 */
export interface SeekKey {
  readonly key: readonly unknown[];
  readonly id: unknown;
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
    id,
  };
}

/** Appended by `totalOrder`. Ascending whatever the declared keys do — so is the seek predicate. */
const ID_TIEBREAK: OrderKey = { column: 'id', direction: 'asc' };

/**
 * The ordering a read is actually served in: the declared keys, then `id` to make it total.
 *
 * Two rows sharing every declared sort value have no order at all without it — the database
 * returns them either way round while `isAfterKey` decides the next page as though `id` had
 * settled it. `Builder.seek()` compiles this list, `paginate()` sorts by it, and the matcher
 * places a row by it: a row inserted at the end of a tie group is a row the next re-read finds
 * somewhere else. An ordering that already names `id` is total, and adding a second `id` term
 * would compare the key to itself.
 */
export function totalOrder(orderBy: readonly OrderKey[]): readonly OrderKey[] {
  return orderBy.some((key) => key.column === 'id') ? orderBy : [...orderBy, ID_TIEBREAK];
}

/**
 * SQL NULL, as a row spells it. A column the row simply omits reads `undefined` here and NULL
 * in Postgres, so both are the same absence — otherwise a fixture row without `deletedAt` and
 * the same row round-tripped through a driver answer `where({ deletedAt: null })` differently.
 */
export function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

export function matchesFilters(row: object, filters: readonly Filter[], kindOf: KindOf): boolean {
  return filters.every((filter) => matchesFilter(row, filter, kindOf));
}

/**
 * One filter against one row, as Postgres answers it for that column. `kindOf` is required: a
 * comparison with no declared kind to decide by is how `'10'` in a `bigint()` column sorted before
 * `'9'`, and an optional argument is one a caller forgets.
 */
export function matchesFilter(row: object, filter: Filter, kindOf: KindOf): boolean {
  const actual = columnOf(row, filter.column);
  const kind = kindOf(filter.column);
  switch (filter.op) {
    case '=':
      return equalOrBothNull(kind, actual, filter.value);
    case '!=':
      return !equalOrBothNull(kind, actual, filter.value);
    case 'in':
      return (
        Array.isArray(filter.value) &&
        filter.value.some((item) => equalOrBothNull(kind, actual, item))
      );
    case '>':
    case '>=':
    case '<':
    case '<=':
      return ordered(filter.op, kind, actual, filter.value);
    default:
      return false;
  }
}

/**
 * `col > NULL` is unknown in SQL and unknown is not a match, so a NULL on either side of an
 * ordering operator matches nothing here either. Only `=`, `!=` and `in` read NULL as a value —
 * and those are exactly the three `Builder.toSQL()` compiles to `is null` / `is distinct from`.
 */
function ordered(
  op: '>' | '>=' | '<' | '<=',
  kind: ColumnKind | undefined,
  actual: unknown,
  value: unknown,
): boolean {
  if (isNull(actual) || isNull(value)) return false;
  const result = compareByKind(kind, actual, value);
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
 * This package's NULL rule around `@ultimat3/entity`'s equality: `=`, `!=` and `in` read NULL as a
 * value, so two absences are equal and an absence equals nothing else. What two PRESENT values
 * are to each other is not decided here — `sameValueOfKind` answers by the column's kind.
 */
function equalOrBothNull(kind: ColumnKind | undefined, a: unknown, b: unknown): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  return sameValueOfKind(kind, a, b);
}

/**
 * Row ordering under an `orderBy` list. Stable, and total when an id key is last.
 *
 * Each key is ordered by `@ultimat3/entity`'s `compareByKind` under the column's declared kind —
 * the one JS statement of how Postgres orders a column. NULL is the largest value there and equal
 * to itself, which is what lets `Builder.toSQL()` write `asc nulls last` / `desc nulls first` and
 * mean this function. This package used to keep a second comparator that decided by `typeof`: a
 * `bigint()` or `decimal()` row is decimal TEXT, so `'10'` sorted before `'9'` in the in-memory
 * source, the live matcher and the seek fallback while the database answered the other way.
 */
export function compareRows(
  a: object,
  b: object,
  orderBy: readonly OrderKey[],
  kindOf: KindOf,
): number {
  for (const key of orderBy) {
    const result = compareByKind(
      kindOf(key.column),
      columnOf(a, key.column),
      columnOf(b, key.column),
    );
    if (result !== 0) return key.direction === 'asc' ? result : -result;
  }
  return 0;
}
