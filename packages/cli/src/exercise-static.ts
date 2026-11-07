// The static half of the tenant proof, under the `exercise` step: an entity with no tenant column
// whose references reach one that has a tenant, and no `shared` reason, is a row of one tenant
// readable by id from another — the guard scopes only tables that carry the column. Pure:
// descriptions in, findings out (the tenant columns default to the registry's own projection).

import type { EntityDescription, TenantColumnDescription } from '@ultimat3/entity';
import { describeTenancy } from '@ultimat3/entity';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** `"<table>.<column>"` → the table. Physical names hold no `.`, so the first one splits it. */
const targetTable = (reference: string): string => reference.slice(0, reference.indexOf('.'));

/**
 * The tenant ROOTS: each table a tenant column of `entities` references (`orgs`, for
 * `orgId -> orgs.id`). It carries no tenant column because it IS the tenant — `seedGraph` holds one
 * row of it per tenant (`seed-graph.ts`'s `roots`, the same rule over entity objects).
 */
const tenantRoots = (
  byTable: ReadonlyMap<string, EntityDescription>,
  tenancy: readonly TenantColumnDescription[],
): ReadonlySet<string> => {
  const roots = new Set<string>();
  for (const { table, column } of tenancy) {
    const reference = byTable.get(table)?.columns.find((c) => c.column === column)?.references;
    if (reference === null || reference === undefined) continue;
    if (targetTable(reference) !== table) roots.add(targetTable(reference));
  }
  return roots;
};

/**
 * The shortest reference path from `start` to a tenant-columned entity or a tenant root, or
 * `null`. A `shared` entity is not walked through: its rows belong to no tenant by declaration, so
 * what hangs off it hangs off a global row. Either kind of tenant ends the walk, found.
 */
const pathToTenant = (
  start: EntityDescription,
  byTable: ReadonlyMap<string, EntityDescription>,
  roots: ReadonlySet<string>,
): readonly string[] | null => {
  const seen = new Set([start.table]);
  const queue: (readonly EntityDescription[])[] = [[start]];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const here = path[path.length - 1];
    for (const column of here?.columns ?? []) {
      if (column.references === null) continue;
      const next = byTable.get(targetTable(column.references));
      if (next === undefined || seen.has(next.table)) continue;
      seen.add(next.table);
      if (next.orgScoped || roots.has(next.table)) {
        return [...path, next].map((entity) => entity.name);
      }
      if (next.shared === undefined) queue.push([...path, next]);
    }
  }
  return null;
};

const finding = (entity: EntityDescription, path: readonly string[], root: boolean): Finding => ({
  code: 'X_ENTITY_TENANT_UNDECLARED',
  cause: `${entity.name} has no tenant column and references ${path.join(' -> ')}, ${root ? 'the tenant root' : 'which has one'}, and declares no shared reason: a row of one tenant is readable by id from another. Add a tenant column to its columns, or declare why it belongs to no tenant`,
  fix: `orgId: uuid().tenant()   # in entity('${entity.name}', { columns }), then x db gen ${quoteArg(`${entity.table} tenant`)}; or shared: '<why it belongs to no tenant>' in that entity()`,
  // The registry records no declaring file, so the entity's name is the locator.
  at: entity.name,
});

/**
 * `tenancy` is which column scopes each tenant table — the description does not say — and only
 * rows naming a table in `entities` count, so a registered entity outside the set roots nothing.
 */
export function entityTenantFindings(
  entities: readonly EntityDescription[],
  tenancy: readonly TenantColumnDescription[] = describeTenancy(),
): readonly Finding[] {
  const byTable = new Map(entities.map((entity) => [entity.table, entity]));
  const roots = tenantRoots(byTable, tenancy);
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  return [...entities]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entity) => {
      if (entity.orgScoped || entity.shared !== undefined || roots.has(entity.table)) return [];
      const path = pathToTenant(entity, byTable, roots);
      if (path === null) return [];
      const end = byName.get(path[path.length - 1] ?? '');
      return [finding(entity, path, end !== undefined && !end.orgScoped)];
    });
}
