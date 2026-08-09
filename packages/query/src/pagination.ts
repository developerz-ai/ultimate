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
import { decodeCursor, encodeCursor } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { Query, SourceOptions } from './query';
import { queryHash, queryName, sourceFor } from './query';
import type { QueryShape, SeekKey } from './shape';
import { seekKeyOf } from './shape';
import type { SqlSource } from './source';

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
 * One page. Push-down when the source implements `seek()`; otherwise the rows are
 * sliced after execution and the source is doing more work than it should.
 */
export async function paginate<TInput extends StandardSchemaV1, TRow extends object>(
  target: Query<TInput, TRow>,
  input: unknown,
  args: PaginateArgs,
): Promise<Page<TRow>> {
  const name = queryName(target);
  const hash = queryHash(name, input);
  // The scope is this read plus these arguments: a cursor from anywhere else is
  // already `X_CURSOR_INVALID` by the time it gets here.
  const decoded = args.after === undefined ? null : decodeCursor(args.after, hash);
  const after: SeekKey | null = decoded === null ? null : { key: decoded.key, id: decoded.id };
  const base = await sourceFor(target, input, args);
  const shape = base.shape();

  // Fetch one extra row: its presence *is* `hasNextPage`, with no count query.
  const window = args.first + 1;
  const source: SqlSource<object> = base.seek === undefined ? base : base.seek(after, window);
  const executed = await source.execute();
  const scoped = base.seek === undefined ? sliceAfter(executed, after, shape) : executed;
  // The source came from this query's own `sql()`, so its rows are TRow.
  const rows = scoped.slice(0, args.first) as unknown as readonly TRow[];
  const last = rows[rows.length - 1];
  const seek = last === undefined ? null : seekKeyOf(last, shape);

  return {
    rows,
    endCursor: seek === null ? null : encodeCursor({ scope: hash, key: seek.key, id: seek.id }),
    hasNextPage: scoped.length > args.first,
  };
}

function sliceAfter(
  rows: readonly object[],
  after: SeekKey | null,
  shape: QueryShape,
): readonly object[] {
  if (after === null) return rows;
  const index = rows.findIndex((row) => seekKeyOf(row, shape).id === after.id);
  return index === -1 ? rows : rows.slice(index + 1);
}
