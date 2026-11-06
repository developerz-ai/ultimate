// Single responsibility: the tenant column of every registered tenant table, physical names only —
// what `x db gen` writes a row-security policy over. Beside the description, never on it: `x
// verify` hashes `describeEntities()`, and every tenant app's hash would move for a fact it has.

import { registeredEntities } from './registry';

/** One tenant table: its physical table and the physical column its rows are scoped by. */
export interface TenantColumnDescription {
  readonly table: string;
  readonly column: string;
}

/**
 * In the registry's own order (by entity name, then sorted by table for a stable migration). An
 * entry with no `core` is a hand-registered test double, never an `entity()`: it declares nothing.
 */
export const describeTenancy = (): readonly TenantColumnDescription[] =>
  registeredEntities()
    .flatMap((entry): TenantColumnDescription[] => {
      const property = entry.core?.$tenantColumn ?? null;
      if (property === null) return [];
      const column = entry.describe().columns.find((candidate) => candidate.property === property);
      return column === undefined ? [] : [{ table: entry.tableName, column: column.column }];
    })
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
