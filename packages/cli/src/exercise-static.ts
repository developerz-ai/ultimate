// The static half of the tenant proof, under the `exercise` step: an entity with no tenant column
// whose references reach one that has a tenant, and no `shared` reason, is a row of one tenant
// readable by id from another — the guard scopes only tables that carry the column. Pure:
// descriptions in, findings out.

import type { EntityDescription } from '@ultimat3/entity';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** `"<table>.<column>"` → the table. Physical names hold no `.`, so the first one splits it. */
const targetTable = (reference: string): string => reference.slice(0, reference.indexOf('.'));

/**
 * The shortest reference path from `start` to a tenant-columned entity, or `null`. A `shared`
 * entity is not walked through: its rows belong to no tenant by declaration, so what hangs off it
 * hangs off a global row. An entity with a tenant column ends the walk, found.
 */
const pathToTenant = (
  start: EntityDescription,
  byTable: ReadonlyMap<string, EntityDescription>,
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
      if (next.orgScoped) return [...path, next].map((entity) => entity.name);
      if (next.shared === undefined) queue.push([...path, next]);
    }
  }
  return null;
};

const finding = (entity: EntityDescription, path: readonly string[]): Finding => ({
  code: 'X_ENTITY_TENANT_UNDECLARED',
  cause: `${entity.name} has no tenant column and references ${path.join(' -> ')}, which has one, and declares no shared reason: a row of one tenant is readable by id from another. Add a tenant column to its columns, or declare why it belongs to no tenant`,
  fix: `orgId: uuid().tenant()   # in entity('${entity.name}', { columns }), then x db gen ${quoteArg(`${entity.table} tenant`)}; or shared: '<why it belongs to no tenant>' in that entity()`,
  // The registry records no declaring file, so the entity's name is the locator.
  at: entity.name,
});

export function entityTenantFindings(entities: readonly EntityDescription[]): readonly Finding[] {
  const byTable = new Map(entities.map((entity) => [entity.table, entity]));
  return [...entities]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entity) => {
      if (entity.orgScoped || entity.shared !== undefined) return [];
      const path = pathToTenant(entity, byTable);
      return path === null ? [] : [finding(entity, path)];
    });
}
