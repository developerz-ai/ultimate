// The predicates one read of a resource carries, composed in one place: the resource's row scope
// (who may see which rows at all), then the list's scope, then the caller's filters. Every read
// the admin issues — list, search, detail, lookup, labels, the MCP tools — builds its `where`
// here, so "this actor never sees that row" is one function and not five call sites agreeing.

import type { AdminActor } from './authz';
import { AdminFilterInvalidError } from './errors';
import type { AdminFilter, AdminRow, AdminSort } from './registry';
import { type AdminResource, repoOf } from './resource';
import type { AdminScope } from './resource-list';

/** One list, as a caller asks for it. `scope` and `filters` are names the resource must derive. */
export interface AdminListRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sort?: AdminSort;
  /**
   * A declared scope's name. Absent is the resource's default scope, or none. `null` is "no scope,
   * not even the default" — what a lookup asks, because a label is owed for a row in ANY scope.
   */
  readonly scope?: string | null;
  /** Already checked — `checkedFilter` is the only thing that builds one from a caller's input. */
  readonly filters?: readonly AdminFilter[];
}

/** The rows of `resource` this actor may see at all — empty when the resource declares no `rows`. */
export function rowWhere(resource: AdminResource, actor: AdminActor): readonly AdminFilter[] {
  return resource.rowScope?.(actor) ?? [];
}

/**
 * The scope a request names; the default one when it names none; `undefined` when the resource
 * has no default. A name nobody declared is refused — a typo must not read as "every row".
 */
export function scopeNamed(
  resource: AdminResource,
  name: string | null | undefined,
): AdminScope | undefined {
  if (name === null) return undefined;
  if (name === undefined || name === '') return resource.scopes.find((scope) => scope.default);
  const found = resource.scopes.find((scope) => scope.name === name);
  if (found !== undefined) return found;
  throw new AdminFilterInvalidError({
    entity: resource.name,
    asked: `scope=${name}`,
    cause: 'is not a scope of this resource',
    known: resource.scopes.map((scope) => `scope=${scope.name}`),
  });
}

export interface ListWhere {
  readonly scope: AdminScope | undefined;
  readonly where: readonly AdminFilter[];
}

/** Row scope, then scope, then filters — a conjunction, in the order they narrow. */
export function listWhere(
  resource: AdminResource,
  actor: AdminActor,
  request: Pick<AdminListRequest, 'scope' | 'filters'>,
): ListWhere {
  const scope = scopeNamed(resource, request.scope);
  return {
    scope,
    where: [
      ...rowWhere(resource, actor),
      ...(scope?.where(actor) ?? []),
      ...(request.filters ?? []),
    ],
  };
}

/**
 * One row by id, or `null` — for a row that does not exist AND for one this actor's row scope
 * leaves out, which are the same answer on purpose: a 404 that distinguished them would confirm
 * the row exists.
 *
 * The membership question is put to the repo, never re-evaluated here: a second implementation of
 * `contains` or `in` in this file would be a second opinion about what a predicate means. It costs
 * one extra read, and only for a resource that declares `rows`.
 */
export async function findRow<Row extends AdminRow>(
  resource: AdminResource<Row>,
  actor: AdminActor,
  id: string,
): Promise<Row | null> {
  const repo = repoOf(resource);
  const row = await repo.find(id);
  if (row === null || resource.rowScope === undefined) return row;
  const visible = await repo.list({
    where: [...resource.rowScope(actor), { field: resource.idField, op: 'eq', value: id }],
    sort: resource.defaultSort,
    limit: 1,
  });
  return visible.length === 0 ? null : row;
}

/**
 * The count behind each tab that asked for one — `count: true` — and no other. One query per
 * counted scope: the row scope and the scope's own predicates, never the caller's filters, so a
 * tab's number is the size of the scope and does not move as the operator types.
 */
export async function scopeCounts(
  resource: AdminResource,
  actor: AdminActor,
): Promise<ReadonlyMap<string, number>> {
  const counted = resource.scopes.filter((scope) => scope.count);
  const count = repoOf(resource).count;
  if (counted.length === 0 || count === undefined) return new Map();
  const rows = rowWhere(resource, actor);
  const totals = await Promise.all(counted.map((scope) => count([...rows, ...scope.where(actor)])));
  return new Map(counted.map((scope, index) => [scope.name, totals[index] ?? 0]));
}
