/**
 * Cursor pagination, and only cursor pagination.
 *
 * OFFSET IS NOT AVAILABLE ON PURPOSE: `offset` makes the database count rows it
 * will throw away (O(offset) per page), and any insert or delete before the
 * offset shifts every later page, so users see duplicates and holes. A keyset
 * cursor is O(log n) on the ordering index and stable under concurrent writes.
 *
 * The codec is `@ultimat3/core`'s. This file only decides what a cursor is bound
 * to — `queryHash(name, input)` — so one read's cursor cannot page another.
 */
import { assert, decodeCursor, encodeCursor } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import type { Query, SourceOptions } from './query';
import { queryHash, queryName, sourceFor } from './query';
import type { QueryShape, SeekKey } from './shape';
import { compareRows, seekKeyOf, totalOrder } from './shape';
import type { SqlSource } from './source';
import { isAfterKey } from './source';

export interface Page<TRow> {
  readonly rows: readonly TRow[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export interface PaginateArgs extends SourceOptions {
  readonly first: number;
  readonly after?: string;
}

/**
 * The largest page a read will serve. A TWIN of `@ultimat3/entity`'s `MAX_PAGE_SIZE` — this
 * package holds no dependency on that one, the same compromise `naming.ts` and `deprecation.ts`
 * are ported under — and it exists for the same reason: `first` reaches here straight from an
 * action's input or a route parameter, so `args.first + 1` bound whatever a client sent and one
 * request could ask for five million rows.
 */
const MAX_PAGE_SIZE = 10_000;

/**
 * One page. Push-down when the source implements `seek()`; otherwise the rows are
 * sliced after execution and the source is doing more work than it should.
 */
export async function paginate<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  input: unknown,
  args: PaginateArgs,
): Promise<Page<TRow>> {
  assert(
    Number.isInteger(args.first) && args.first >= 1 && args.first <= MAX_PAGE_SIZE,
    `first must be a whole number of rows between 1 and ${MAX_PAGE_SIZE}`,
    `read.page(input, { first: Math.min(requested, ${MAX_PAGE_SIZE}) }) — or bound it in the input schema: t.number.int().min(1).max(50)`,
  );
  const name = queryName(target);
  const hash = queryHash(name, input);
  // The scope is this read plus these arguments: a cursor from anywhere else is
  // already `X_CURSOR_INVALID` by the time it gets here.
  const decoded = args.after === undefined ? null : decodeCursor(args.after, hash);
  // Revived to the types the columns hold, never left as the strings JSON handed back: a `Date`
  // key decoded as an ISO string reaches `compareValues` as text and is compared against the
  // row's own millisecond number, so page two matched nothing at all. See `cursor-value.ts`.
  const after: SeekKey | null =
    decoded === null ? null : { key: reviveSortKey(decoded.key), id: decoded.id };
  const base = await sourceFor(target, input, args);
  const shape = base.shape();

  // Fetch one extra row: its presence *is* `hasNextPage`, with no count query.
  const window = args.first + 1;
  const source: SqlSource<object> = base.seek === undefined ? base : base.seek(after, window);
  const executed = await source.execute();
  const scoped = base.seek === undefined ? inTotalOrder(executed, after, shape) : executed;
  // The source came from this query's own `sql()`, so its rows are TRow.
  const rows = scoped.slice(0, args.first) as unknown as readonly TRow[];
  const last = rows[rows.length - 1];
  const seek = last === undefined ? null : seekKeyOf(last, shape);

  return {
    rows,
    endCursor:
      seek === null
        ? null
        : encodeCursor({ scope: hash, key: seek.key.map(serializeSortValue), id: seek.id }),
    hasNextPage: scoped.length > args.first,
  };
}

/**
 * The cursor names a POSITION in the ordering, so the fallback filters by that position — the
 * same comparison `Builder.seek()` pushes into SQL. Locating the cursor's row by id instead
 * looks equivalent and is not: the row can be gone by the next request, `findIndex` answers -1,
 * and every row from the top comes back as page two. Under a delete between two pages that is a
 * silent restart, which is the failure keyset pagination exists to make impossible.
 *
 * **It SORTS first, and that half was missing.** `isAfterKey` breaks a tie on the declared keys by
 * `id` — it has to, or the cut is not a position at all — while a foreign `SqlSource` ordered its
 * rows by the DECLARED keys alone. So a tie group arrived in an order the cut does not describe,
 * and the cut fell in the middle of it: page one served `a(10), d(20)`, the cursor named `(20, d)`,
 * and rows `b(20)` and `c(20)` matched no page in the listing. Rows VANISH — silently, and only
 * where two rows share a sort key.
 *
 * `Builder` has always done this: `execute()` sorts by `servedOrder()`, which appends `id` once a
 * read asked to be seekable. This is that rule applied to the path a `Builder` does not take, and
 * it is the ordering the cursor arithmetic already assumes on both sides. Reachable only for a
 * hand-written `SqlSource` with no `seek()` — the branch this whole function exists for.
 */
function inTotalOrder(
  rows: readonly object[],
  after: SeekKey | null,
  shape: QueryShape,
): readonly object[] {
  const keys = totalOrder(shape.orderBy);
  const ordered = [...rows].sort((left, right) => compareRows(left, right, keys));
  if (after === null) return ordered;
  return ordered.filter((row) => isAfterKey(row, after, shape.orderBy));
}
