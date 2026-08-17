// Cursor pagination, and only cursor pagination. `AdminListQuery` has no `offset` field, so
// "page 400" cannot be expressed: an operator paging a table that is being written to would
// otherwise skip and repeat rows, and every page would re-scan everything before it.
// The position itself is encoded by `@ultimat3/core` — one signed cursor format, framework-wide.

import { decodeCursor, encodeCursor, isUltimateError } from '@ultimat3/core';
import type { AdminFilter, AdminListQuery, AdminRow, AdminSort } from './registry';
import { rowId } from './registry';
import { type AdminResource, repoOf } from './resource';

export interface AdminCursor {
  readonly field: string;
  readonly value: string;
  readonly id: string;
  readonly direction: 'after' | 'before';
}

/** Asking for the name alone keeps the codec free of the row generic. */
type CursorResource = Pick<AdminResource, 'name'>;

/**
 * The signed scope binds a cursor to the resource that issued it: a position taken from the
 * posts table cannot be replayed against users, whatever an operator pastes into the URL.
 */
const cursorScope = (resource: CursorResource): string => `admin:${resource.name}`;

export function encodeAdminCursor(resource: CursorResource, cursor: AdminCursor): string {
  return encodeCursor({
    scope: cursorScope(resource),
    key: [cursor.direction, cursor.field, cursor.value],
    id: cursor.id,
  });
}

/**
 * An unreadable cursor yields `null`, i.e. the first page — a stale bookmark or a hand-edited
 * URL should show the operator page one, not an error page. Deliberately softer than the repo
 * and the read primitive, which surface `X_CURSOR_INVALID`: those are called by code that must
 * learn it paged wrong, while a human just wants the table to render. Forgery is covered either
 * way — core verifies the signature before the payload is trusted, so a tampered or borrowed
 * cursor lands on page one instead of a seek position the client invented.
 */
export function decodeAdminCursor(
  resource: CursorResource,
  raw: string | null | undefined,
): AdminCursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const payload = decodeCursor(raw, cursorScope(resource));
    if (payload.key.length !== 3) return null;
    const [direction, field, value] = payload.key;
    if (direction !== 'after' && direction !== 'before') return null;
    if (typeof field !== 'string' || typeof value !== 'string') return null;
    return { direction, field, value, id: payload.id };
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_CURSOR_INVALID') return null;
    throw error;
  }
}

export interface PageRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sort?: AdminSort;
  readonly where?: readonly AdminFilter[];
}

export interface AdminPage<Row extends AdminRow> {
  readonly rows: readonly Row[];
  readonly sort: AdminSort;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  /** A page exists AFTER this one — what the Next control is enabled by, in both directions. */
  readonly hasMore: boolean;
}

/** The repo query for one page. Asks for `limit + 1` to learn whether a next page exists. */
export function listQuery<Row extends AdminRow>(
  resource: AdminResource<Row>,
  req: PageRequest = {},
): AdminListQuery {
  const sort = req.sort ?? resource.defaultSort;
  const limit = Math.max(1, Math.min(req.limit ?? resource.pageSize, 200));
  const cursor = decodeAdminCursor(resource, req.cursor);
  const bound =
    cursor === null ? undefined : { field: cursor.field, value: cursor.value, id: cursor.id };

  return {
    sort,
    limit: limit + 1,
    ...(req.where === undefined ? {} : { where: req.where }),
    ...(bound === undefined
      ? {}
      : cursor?.direction === 'before'
        ? { before: bound }
        : { after: bound }),
  };
}

const cursorValue = (row: AdminRow, field: string): string => {
  const value = row[field];
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
};

/**
 * Turn `limit + 1` rows into a page plus the cursors that walk off either end.
 *
 * The extra row is on the side the keyset walked TOWARD, so the direction decides everything:
 *  - `after` (and the first page, which has no cursor): the overflow row is the tail, and it means
 *    a next page exists. A previous page exists iff a cursor got us here.
 *  - `before`: the overflow row is the HEAD — the repo returns the page in the query's sort order,
 *    so the row furthest back is index 0 — and it means a *previous* page exists. A next page
 *    always exists, because paging backwards is only reachable from a later page.
 *
 * Reading `hasMore` as "the fetch overflowed" regardless of direction disabled Next on every
 * backward page (the operator could not walk back to where they came from) and left Previous
 * enabled past the first row; trimming the tail on a backward page silently skipped the row next
 * to the cursor. One flag, both bugs.
 */
export function pageFrom<Row extends AdminRow>(
  resource: AdminResource<Row>,
  req: PageRequest,
  fetched: readonly Row[],
): AdminPage<Row> {
  const sort = req.sort ?? resource.defaultSort;
  const pageSize = Math.max(1, Math.min(req.limit ?? resource.pageSize, 200));
  const incoming = decodeAdminCursor(resource, req.cursor);
  const backwards = incoming?.direction === 'before';
  const overflow = fetched.length > pageSize;

  const rows = !overflow
    ? fetched
    : backwards
      ? fetched.slice(fetched.length - pageSize)
      : fetched.slice(0, pageSize);
  const last = rows[rows.length - 1];
  const first = rows[0];

  const hasMore = backwards ? true : overflow;
  const hasPrevious = backwards ? overflow : incoming !== null;

  return {
    rows,
    sort,
    pageSize,
    hasMore,
    nextCursor:
      hasMore && last !== undefined
        ? encodeAdminCursor(resource, {
            direction: 'after',
            field: sort.field,
            value: cursorValue(last, sort.field),
            id: rowId(last, resource.idField),
          })
        : null,
    prevCursor:
      hasPrevious && first !== undefined
        ? encodeAdminCursor(resource, {
            direction: 'before',
            field: sort.field,
            value: cursorValue(first, sort.field),
            id: rowId(first, resource.idField),
          })
        : null,
  };
}

export async function fetchPage<Row extends AdminRow>(
  resource: AdminResource<Row>,
  req: PageRequest = {},
): Promise<AdminPage<Row>> {
  const fetched = await repoOf(resource).list(listQuery(resource, req));
  return pageFrom(resource, req, fetched);
}
