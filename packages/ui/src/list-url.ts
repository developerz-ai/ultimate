// A list's state in its URL — sort, cursor, limit, search — read leniently and written as hrefs, so
// a server-rendered `DataTable` sorts and pages with no island and an island reads the same URL.
// Pure: no DOM, no router. Beside `sort-state.ts`, whose `SortState` it speaks.

import type { SortDirection, SortState } from './components/sort-state';

/** The page size a URL may ask for: `default` when absent or unreadable, never above `max`. */
export interface ListLimit {
  readonly default: number;
  readonly max: number;
}

export interface ListUrlOptions<S extends string> {
  /** The column keys the list can sort by. Any other `sort` in the URL is no sort. */
  readonly sorts: readonly S[];
  /**
   * Prefixes every parameter (`runs.after`), for two lists on one page. With it, any change but a
   * cursor drops EVERY cursor on the page: a cursor is bound to the filter and sort it was minted
   * under, and the server refuses a stale one (`X_CURSOR_INVALID`).
   */
  readonly ns?: string | undefined;
  readonly limit?: ListLimit | undefined;
}

/** What `href` changes. A key present with `undefined` removes that parameter. */
export interface ListChange {
  readonly sort?: SortState | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListUrl<S extends string> {
  readonly sort: (SortState & { readonly key: S }) | undefined;
  /** The opaque cursor to read after; `undefined` on the first page. */
  readonly cursor: string | undefined;
  readonly limit: number;
  /** The search text, trimmed; `undefined` when empty. */
  readonly q: string | undefined;
  /** The list under `change`, every other parameter kept, its cursor dropped. */
  href(change: ListChange): string;
  /** `DataTable`/`Pagination`'s `hrefFor`: the same list at `cursor`, everything else kept. */
  hrefFor(cursor: string, direction: 'next' | 'prev'): string;
  /** `DataTable`'s `sortHrefFor`: the list under the next sort state; `undefined` is unsorted. */
  sortHrefFor(sort: SortState | undefined): string;
  /** The first page — the list without its cursor. `undefined` when already there. */
  readonly firstHref: string | undefined;
}

const DEFAULT_LIMIT: ListLimit = { default: 50, max: 100 };

/** A relative URL needs a base to parse; it never reaches an href, which is path and query only. */
const BASE = 'http://list.invalid';

const CURSOR = 'after';

const isCursorParam = (name: string): boolean => name === CURSOR || name.endsWith(`.${CURSOR}`);

const direction = (raw: string | null): SortDirection => (raw === 'desc' ? 'desc' : 'asc');

const readLimit = (raw: string | null, bounds: ListLimit): number => {
  if (raw === null || !/^\d+$/.test(raw)) return bounds.default;
  const value = Number(raw);
  return value >= 1 && value <= bounds.max ? value : bounds.default;
};

const present = (raw: string | null): string | undefined => {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
};

export function listUrl<S extends string>(
  url: URL | string,
  options: ListUrlOptions<S>,
): ListUrl<S> {
  const parsed = new URL(url, BASE);
  const name = (param: string): string =>
    options.ns === undefined ? param : `${options.ns}.${param}`;
  const params = parsed.searchParams;

  const rawSort = params.get(name('sort'));
  const key = options.sorts.find((candidate) => candidate === rawSort);
  const sort =
    key === undefined ? undefined : { key, direction: direction(params.get(name('dir'))) };
  const cursor = present(params.get(name(CURSOR)));

  const write = (edit: (next: URLSearchParams) => void): string => {
    const next = new URLSearchParams(params);
    edit(next);
    const search = next.toString();
    return search === '' ? parsed.pathname : `${parsed.pathname}?${search}`;
  };
  const put = (next: URLSearchParams, param: string, value: string | undefined): void => {
    if (value === undefined) next.delete(name(param));
    else next.set(name(param), value);
  };
  /** Without `ns` the list owns one cursor; with it, a filter change resets every list. */
  const dropCursors = (next: URLSearchParams): void => {
    const cursors = options.ns === undefined ? [CURSOR] : [...next.keys()].filter(isCursorParam);
    for (const param of cursors) next.delete(param);
  };

  const href = (change: ListChange): string =>
    write((next) => {
      dropCursors(next);
      if ('sort' in change) {
        put(next, 'sort', change.sort?.key);
        put(next, 'dir', change.sort?.direction);
      }
      if ('q' in change) put(next, 'q', present(change.q ?? null));
      if ('limit' in change) put(next, 'limit', change.limit?.toString());
    });

  return {
    sort,
    cursor,
    limit: readLimit(params.get(name('limit')), options.limit ?? DEFAULT_LIMIT),
    q: present(params.get(name('q'))),
    href,
    hrefFor: (to) => write((next) => put(next, CURSOR, to)),
    sortHrefFor: (next) => href({ sort: next }),
    firstHref: cursor === undefined ? undefined : write((next) => put(next, CURSOR, undefined)),
  };
}
