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
import type { CursorPayload, Page } from '@ultimat3/core';
import { assert, CursorInvalidError, decodeCursor, encodeCursor, pageOf } from '@ultimat3/core';
import { MAX_PAGE_SIZE } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { reviveSortKey, serializeSortValue } from './cursor-value';
import { pageWindow } from './page-window';
import type { Query, SourceOptions } from './query';
import { queryHash, queryName } from './query';
import { readCall } from './read';
import type { SeekKey } from './shape';
import { seekKeyOf } from './shape';
import type { SqlSource } from './source';

/**
 * One page is `@ultimat3/core`'s `Page` — the framework's ONE page shape (O-12, 25.0.0), the same
 * type `@ultimat3/entity`'s `findMany` answers, re-exported so a `query` file needs one import.
 * `nextCursor` is `null` exactly when `hasMore` is false: before 25.0.0 this page kept a cursor on
 * its LAST page, so a `while (page.nextCursor)` loop fetched an empty page past the end.
 */
export type { Page } from '@ultimat3/core';

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
  // One call: an audited read's record covers the build AND the page it serves — the early return
  // below included, since a caller refused nothing and was answered (`audit-gate.ts`).
  return readCall(target, input, args, (base) => pageFrom<TRow>(base, decoded, args.first, hash));
}

/** The page itself, over a source `readCall` already validated, authorized and built. */
async function pageFrom<TRow extends object>(
  base: SqlSource<object>,
  decoded: CursorPayload | null,
  first: number,
  hash: string,
): Promise<Page<TRow>> {
  const shape = base.shape();
  // Revived to the types the columns hold, never left as the strings JSON handed back: a `Date`
  // key decoded as an ISO string was compared as text against the row's own instant, so page two
  // matched nothing at all. See `cursor-value.ts`.
  const resumed = decoded === null ? null : seekFromCursor(decoded, shape.orderBy.length);
  const after = resumed?.seek ?? null;
  const left = rowsLeft(shape.limit, resumed);
  // The whole of a declared limit is already served: there is no row to ask the source for.
  if (left === 0) return pageOf<TRow>([], null);

  // `MAX_PAGE_SIZE` is `@ultimat3/entity`'s: `page-controls.ts` checks the same bound at the wire, as
  // a 400, before this `assert` — which is a 500 — can see the number. The window reads one extra
  // row (its presence *is* `hasMore`, with no count query), never past what a declared `.limit()`
  // has left — `first` used to REPLACE that limit, so `?_first=10000` walked a "top 3" to the end.
  const window = await pageWindow(base, after, first, left, shape);
  // The source came from this query's own `sql()`, so its rows are TRow.
  const rows = window.rows as unknown as readonly TRow[];
  // Read on EVERY page with a position, the last included: a read with no id is refused as
  // unpageable on page one, never only once its listing grows past one page.
  const seek = window.position === undefined ? null : seekKeyOf(window.position, shape);

  // A cursor is minted only when another page follows (`window.more`): the position of the
  // last row of the LAST page is not a next page, and handing it back made a
  // `while (page.nextCursor)` loop fetch an empty page past the end.
  const nextCursor =
    seek === null || !window.more
      ? null
      : encodeCursor({
          scope: hash,
          // The id rides TYPED at the tail of the key — core's `id` slot is a string — so a
          // numeric or bigint tiebreak compares as a number on the next page, not lexically.
          // A limited read appends how much of its limit is now spent: a keyset cursor names a
          // position and no count, and the count is the only thing that can end a "top N". It
          // counts SOURCE rows, as the whole read's `limit` does: a row a rule dropped is spent.
          key: [
            ...[...seek.key, seek.id].map(serializeSortValue),
            ...(shape.limit === null ? [] : [(resumed?.served ?? 0) + window.consumed]),
          ],
          id: String(seek.id),
        });
  return pageOf(rows, nextCursor);
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
