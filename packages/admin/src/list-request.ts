// URL ⇄ the list a resource is asked for. A list page's whole state lives in its query string —
// cursor, sort, scope and filters — so paging, sorting, scoping and filtering are links and one
// GET form, and a list needs no script. One parser and one builder, so the two cannot disagree
// about a parameter's name. A parameter the resource does not derive is refused, never ignored:
// a typo that silently showed every row is how an operator acts on the wrong list.
//
//   ?cursor=<signed>            keyset position (pagination.ts)
//   ?sort=<field>:<asc|desc>    a sortable field; the direction defaults to desc
//   ?scope=<name>               a declared scope; absent is the resource's default
//   ?f.<field>=<value>          a filter, by the field's default operator
//   ?f.<field>.<op>=<value>     a filter, by a named operator; repeat the parameter for `in`
//
// An EMPTY value is no parameter at all: a GET form submits every input it holds.

import { AdminFilterInvalidError } from './errors';
import { checkedFilter, FILTER_PREFIX, filterParam, knownFilterParams } from './list-filters';
import type { AdminListRequest } from './list-scope';
import { scopeNamed } from './list-scope';
import type { AdminFilter, AdminSort } from './registry';
import type { AdminResource } from './resource';

export const CURSOR_PARAM = 'cursor';
export const SORT_PARAM = 'sort';
export const SCOPE_PARAM = 'scope';

const sortable = (resource: AdminResource): readonly string[] =>
  resource.fields.filter((field) => field.sortable).map((field) => `${SORT_PARAM}=${field.name}`);

/** `createdAt:desc`. A bare field sorts descending — the default everywhere. */
const sortOf = (resource: AdminResource, raw: string): AdminSort => {
  const at = raw.lastIndexOf(':');
  const name = at < 0 ? raw : raw.slice(0, at);
  const direction = at < 0 ? 'desc' : raw.slice(at + 1);
  const refuse = (cause: string): never => {
    throw new AdminFilterInvalidError({
      entity: resource.name,
      asked: `${SORT_PARAM}=${raw}`,
      cause,
      known: sortable(resource),
    });
  };
  // A column the resource derives as sortable: an arbitrary name here would be an `order by` on a
  // column with no index, chosen by whoever typed the URL.
  const field = resource.fields.find((known) => known.name === name && known.sortable);
  if (field === undefined) return refuse('names a field this resource cannot sort by');
  if (direction !== 'asc' && direction !== 'desc') {
    return refuse('names a direction that is neither asc nor desc');
  }
  return { field: field.name, direction };
};

/** `f.title.eq` → `{ field: 'title', op: 'eq' }`. A field name never holds a dot. */
const filterKey = (key: string): { readonly field: string; readonly op?: string } => {
  const rest = key.slice(FILTER_PREFIX.length);
  const dot = rest.indexOf('.');
  return dot < 0 ? { field: rest } : { field: rest.slice(0, dot), op: rest.slice(dot + 1) };
};

/** The list a URL asks for. Absent parameters are the resource's own defaults. */
export function pageRequestOf(resource: AdminResource, url: URL): AdminListRequest {
  const filters: AdminFilter[] = [];
  let cursor: string | undefined;
  let sort: AdminSort | undefined;
  let scope: string | undefined;

  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key).filter((value) => value !== '');
    const last = values[values.length - 1];
    if (last === undefined) continue;
    if (key === CURSOR_PARAM) cursor = last;
    else if (key === SORT_PARAM) sort = sortOf(resource, last);
    // Resolved here for its refusal alone: the name is what travels, the actor decides its rows.
    else if (key === SCOPE_PARAM) scope = scopeNamed(resource, last)?.name;
    else if (key.startsWith(FILTER_PREFIX)) {
      filters.push(checkedFilter(resource, { ...filterKey(key), value: values }));
    } else {
      throw new AdminFilterInvalidError({
        entity: resource.name,
        asked: key,
        cause: 'is not a parameter a list reads',
        known: [CURSOR_PARAM, SORT_PARAM, SCOPE_PARAM, ...knownFilterParams(resource)],
      });
    }
  }

  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(sort === undefined ? {} : { sort }),
    ...(scope === undefined ? {} : { scope }),
    ...(filters.length === 0 ? {} : { filters }),
  };
}

export interface ListLocation {
  readonly cursor?: string | null;
  readonly sort?: AdminSort;
  readonly scope?: string | null;
  readonly filters?: readonly AdminFilter[];
}

const written = (value: AdminFilter['value']): readonly string[] =>
  value === null ? [] : typeof value === 'object' ? value : [String(value)];

/** The URL of one list state, rooted at the admin's own base path. */
export function listHref(
  basePath: string,
  resource: Pick<AdminResource, 'path' | 'filters'>,
  location: ListLocation = {},
): string {
  const query = new URLSearchParams();
  if (location.scope !== undefined && location.scope !== null) {
    query.set(SCOPE_PARAM, location.scope);
  }
  for (const filter of location.filters ?? []) {
    const field = resource.filters.find((known) => known.name === filter.field);
    if (field === undefined) continue;
    for (const value of written(filter.value)) query.append(filterParam(field, filter.op), value);
  }
  if (location.sort !== undefined) {
    query.set(SORT_PARAM, `${location.sort.field}:${location.sort.direction}`);
  }
  if (location.cursor !== undefined && location.cursor !== null) {
    query.set(CURSOR_PARAM, location.cursor);
  }
  const search = query.toString();
  return `${basePath}${resource.path}${search === '' ? '' : `?${search}`}`;
}
