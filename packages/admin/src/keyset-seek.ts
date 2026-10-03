// The keyset seek on the PAIR `(sort, id)`, for a typed handle whose chain is a conjunction: the
// row-value comparison `(sort, id) > (v, id₀)` is read as disjoint segments in walk order — the
// rest of the boundary's class by id, then everything past the class, then the NULLs — so a sort
// value shared by any number of rows, and a NULL one, is a position like any other.

import type { AdminListQuery, AdminRow, AdminTableRead, KeysetBound } from './registry';

type TableOperator = Parameters<AdminTableRead['andWhere']>[1];
type Direction = 'asc' | 'desc';

/** One `andWhere` term. `value` is absent for the two null tests. */
export interface SeekTerm {
  readonly field: string;
  readonly op: TableOperator;
  readonly value?: unknown;
}

export interface SeekColumn {
  readonly field: string;
  readonly idField: string;
  readonly nullable: boolean;
  /**
   * A `timestamptz`. The row hands it back as a `Date` — milliseconds — while Postgres keeps and
   * orders microseconds, so a cursor can only name the boundary's MILLISECOND. Its class is that
   * millisecond `[v, v + 1ms)`, ordered by id inside: the order both drivers can agree on.
   */
  readonly instant: boolean;
  /** The bound's text back to what the handle compares: a `Date` for an instant. */
  readonly typed: (value: string) => unknown;
}

const flip = (direction: Direction): Direction => (direction === 'asc' ? 'desc' : 'asc');

const millisOf = (row: AdminRow, field: string): number | null => {
  const value = row[field];
  return value instanceof Date ? value.getTime() : null;
};

/** Where one walk segment reads. */
interface Segments {
  readonly read: (
    where: readonly SeekTerm[],
    order: 'id' | 'pair',
    limit: number,
  ) => Promise<AdminRow[]>;
  readonly column: SeekColumn;
  readonly walk: Direction;
}

/** The terms that hold the boundary's class: equal, the same millisecond, or NULL. */
const classOf = (column: SeekColumn, value: unknown): readonly SeekTerm[] => {
  if (value === null) return [{ field: column.field, op: 'is-null' }];
  if (column.instant && value instanceof Date) {
    return [
      { field: column.field, op: 'gte', value },
      { field: column.field, op: 'lt', value: new Date(value.getTime() + 1) },
    ];
  }
  return [{ field: column.field, op: 'eq', value }];
};

/** Strictly past the class of a present `value`, in the walk's direction. NULLs never match. */
const pastClass = (column: SeekColumn, value: unknown, walk: Direction): readonly SeekTerm[] => {
  if (walk === 'desc') return [{ field: column.field, op: 'lt', value }];
  if (column.instant && value instanceof Date) {
    return [{ field: column.field, op: 'gte', value: new Date(value.getTime() + 1) }];
  }
  return [{ field: column.field, op: 'gt', value }];
};

/** One class, by id, after `afterId` when given — exact whatever the class's internal order. */
const classRows = (
  at: Segments,
  where: readonly SeekTerm[],
  afterId: string | undefined,
  limit: number,
): Promise<AdminRow[]> =>
  limit <= 0
    ? Promise.resolve([])
    : at.read(
        afterId === undefined
          ? where
          : [
              ...where,
              { field: at.column.idField, op: at.walk === 'asc' ? 'gt' : 'lt', value: afterId },
            ],
        'id',
        limit,
      );

/**
 * Present values past `where`, `limit` of them in `(sort, id)` order. For an instant the LAST
 * millisecond read may be cut part-way through and its rows are in microsecond order, so it is
 * dropped and re-read whole by id — the order the next page's seek resumes in. Every earlier
 * millisecond on the page is complete, and is put in that same order.
 */
async function valueRows(
  at: Segments,
  where: readonly SeekTerm[],
  limit: number,
): Promise<AdminRow[]> {
  if (limit <= 0) return [];
  const { column } = at;
  const present: readonly SeekTerm[] =
    where.length === 0 && column.nullable ? [{ field: column.field, op: 'is-not-null' }] : where;
  if (!column.instant) return at.read(present, 'pair', limit);
  const rows = await at.read(present, 'pair', limit + 1);
  if (rows.length <= limit) return byMillisecondThenId(rows, column, at.walk);
  const tail = millisOf(rows[limit - 1] ?? {}, column.field);
  const extra = millisOf(rows[limit] ?? {}, column.field);
  const kept = rows.slice(0, limit);
  if (tail === null || tail !== extra) return byMillisecondThenId(kept, column, at.walk);
  const whole = kept.filter((row) => millisOf(row, column.field) !== tail);
  const rest = await classRows(
    at,
    classOf(column, new Date(tail)),
    undefined,
    limit - whole.length,
  );
  return [...byMillisecondThenId(whole, column, at.walk), ...rest];
}

/**
 * Rows of one millisecond in id order. Code-unit order: it agrees with the database for a `uuid`
 * key, which is the framework's; a text key under a non-C collation can disagree inside one
 * millisecond, and only there.
 */
const byMillisecondThenId = (
  rows: readonly AdminRow[],
  column: SeekColumn,
  walk: Direction,
): AdminRow[] => {
  const sign = walk === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const at = (millisOf(a, column.field) ?? 0) - (millisOf(b, column.field) ?? 0);
    if (at !== 0) return sign * at;
    const left = String(a[column.idField]);
    const right = String(b[column.idField]);
    return sign * (left < right ? -1 : left > right ? 1 : 0);
  });
};

/**
 * The page a query asks for, read in WALK order — forward from an `after` bound (or from the top),
 * backward from a `before` one — and answered in the query's own sort order either way.
 *
 * NULL is the largest value, as both drivers order it: last ascending, first descending.
 */
export async function seekPage(
  query: AdminListQuery,
  column: SeekColumn,
  read: (
    where: readonly SeekTerm[],
    order: { readonly by: 'id' | 'pair'; readonly direction: Direction },
    limit: number,
  ) => Promise<AdminRow[]>,
): Promise<readonly AdminRow[]> {
  const backward = query.before !== undefined;
  const walk = backward ? flip(query.sort.direction) : query.sort.direction;
  const at: Segments = {
    column,
    walk,
    read: (where, by, limit) => read(where, { by, direction: walk }, limit),
  };
  const out: AdminRow[] = [];
  const room = (): number => query.limit - out.length;
  const bound: KeysetBound | undefined = query.after ?? query.before;
  const nulls = (afterId?: string): Promise<AdminRow[]> =>
    column.nullable ? classRows(at, classOf(column, null), afterId, room()) : Promise.resolve([]);

  if (bound === undefined) {
    if (walk === 'desc') out.push(...(await nulls()));
    out.push(...(await valueRows(at, [], room())));
    if (walk === 'asc') out.push(...(await nulls()));
  } else if (bound.value === null) {
    out.push(...(await nulls(bound.id)));
    if (walk === 'desc') out.push(...(await valueRows(at, [], room())));
  } else {
    const value = column.typed(bound.value);
    // The id IS the sort: its class is one row, so only the strict half is read.
    if (column.field !== column.idField) {
      out.push(...(await classRows(at, classOf(column, value), bound.id, room())));
    }
    out.push(...(await valueRows(at, pastClass(column, value, walk), room())));
    if (walk === 'asc') out.push(...(await nulls()));
  }
  const page = out.slice(0, query.limit);
  return backward ? page.reverse() : page;
}
