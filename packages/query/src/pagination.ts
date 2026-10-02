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
import { kindsOf } from './column-kinds';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import { CursorInvalidError } from './errors';
import { MAX_PAGE_SIZE } from './page-controls';
import type { Query, SourceOptions } from './query';
import { queryHash, queryName, sourceFor } from './query';
import type { QueryShape, SeekKey } from './shape';
import { compareRows, seekKeyOf, totalOrder } from './shape';
import type { SqlSource } from './source';
import { isAfterKey } from './source';

/**
 * One page. `nextCursor` / `hasMore` are the preferred names; `endCursor` / `hasNextPage` are the
 * same two values under the names every client before 22.12 reads — aliases, both always present,
 * never able to disagree because `pageOf` is the one place that writes them.
 */
export interface Page<TRow> {
  readonly rows: readonly TRow[];
  /** The signed cursor that continues this listing; `null` on an empty page. */
  readonly nextCursor: string | null;
  /** Whether another page follows. */
  readonly hasMore: boolean;
  /** Alias of `nextCursor`. */
  readonly endCursor: string | null;
  /** Alias of `hasMore`. */
  readonly hasNextPage: boolean;
}

/** Builds a `Page` from its two facts — the only constructor, so the aliases cannot drift. */
export function pageOf<TRow>(
  rows: readonly TRow[],
  nextCursor: string | null,
  hasMore: boolean,
): Page<TRow> {
  return { rows, nextCursor, hasMore, endCursor: nextCursor, hasNextPage: hasMore };
}

export interface PaginateArgs extends SourceOptions {
  readonly first: number;
  readonly after?: string;
}

/**
 * One page. Push-down when the source implements `seek()`; otherwise the rows are
 * sliced after execution and the source is doing more work than it should.
 */
export async function paginate<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow, boolean>,
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
  const base = await sourceFor(target, input, args);
  const shape = base.shape();
  // Revived to the types the columns hold, never left as the strings JSON handed back: a `Date`
  // key decoded as an ISO string was compared as text against the row's own instant, so page two
  // matched nothing at all. See `cursor-value.ts`.
  const resumed = decoded === null ? null : seekFromCursor(decoded, shape.orderBy.length);
  const after = resumed?.seek ?? null;
  const left = rowsLeft(shape.limit, resumed);
  // The whole of a declared limit is already served: there is no row to ask the source for.
  if (left === 0) return pageOf<TRow>([], null, false);

  // `MAX_PAGE_SIZE` lives in `page-controls.ts`: the route checks the same bound at the wire, as
  // a 400, before this `assert` — which is a 500 — can see the number.
  // Fetch one extra row: its presence *is* `hasNextPage`, with no count query. Never past what a
  // declared `.limit()` has left — `first` used to REPLACE that limit, so `?_first=10000` walked a
  // "top 3" to the end of the table.
  const window = Math.min(left, args.first + 1);
  const source: SqlSource<object> = base.seek === undefined ? base : base.seek(after, window);
  const executed = await source.execute();
  const scoped =
    base.seek === undefined ? inTotalOrder(executed, after, shape).slice(0, window) : executed;
  // The source came from this query's own `sql()`, so its rows are TRow.
  const rows = scoped.slice(0, args.first) as unknown as readonly TRow[];
  const last = rows[rows.length - 1];
  const seek = last === undefined ? null : seekKeyOf(last, shape);

  const nextCursor =
    seek === null
      ? null
      : encodeCursor({
          scope: hash,
          // The id rides TYPED at the tail of the key — core's `id` slot is a string — so a
          // numeric or bigint tiebreak compares as a number on the next page, not lexically.
          // A limited read appends how much of its limit is now spent: a keyset cursor names a
          // position and no count, and the count is the only thing that can end a "top N".
          key: [
            ...[...seek.key, seek.id].map(serializeSortValue),
            ...(shape.limit === null ? [] : [(resumed?.served ?? 0) + rows.length]),
          ],
          id: String(seek.id),
        });
  return pageOf(rows, nextCursor, scoped.length > args.first);
}

/** A decoded cursor: where the page resumes, and how many rows of a declared limit are spent. */
interface Resumed {
  readonly seek: SeekKey;
  readonly served: number | undefined;
}

/**
 * Rows a declared limit still allows, or no bound at all for a read that declares none.
 *
 * A cursor on a limited read MUST say how many rows came before it. One that does not was minted
 * before the limit bounded the listing (or before the read declared one), and honouring it would
 * start a fresh "top N" below the real one — so it is refused as any other cursor this read did
 * not mint, with core's own instruction: request the first page again.
 */
function rowsLeft(limit: number | null, resumed: Resumed | null): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
  if (resumed === null) return Math.max(0, limit);
  const { served } = resumed;
  if (served === undefined || !Number.isInteger(served) || served < 1) {
    throw new CursorInvalidError('it does not say how much of this read’s limit is already served');
  }
  return Math.max(0, limit - served);
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
  const kindOf = kindsOf(shape.entity);
  const ordered = [...rows].sort((left, right) => compareRows(left, right, keys, kindOf));
  if (after === null) return ordered;
  return ordered.filter((row) => isAfterKey(row, after, shape.orderBy, kindOf));
}

/**
 * The seek a decoded cursor names. A cursor carrying more keys than the ordering has its typed id
 * next, then — on a limited read — the count of rows served so far; an older cursor, minted before
 * the id rode there, falls back to the string slot.
 */
function seekFromCursor(
  decoded: { readonly key: readonly unknown[]; readonly id: string },
  width: number,
): Resumed {
  const key = reviveSortKey(decoded.key);
  if (key.length <= width) return { seek: { key, id: decoded.id }, served: undefined };
  const count = key[width + 1];
  return {
    seek: { key: key.slice(0, width), id: key[width] },
    served: typeof count === 'number' ? count : undefined,
  };
}
