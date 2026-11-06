// Single responsibility: the row-security half of one `x db gen` — the flag and each tenant table's
// physical column in, `row-security-plan.ts`'s input out, typed off the entity's own column. Kept
// out of `generate.ts` so the diff loop reads one call, the way the append-only arm does.

import type { EntityDescriptionLike } from './entity-shape';
import type { SchemaDescription } from './introspect';
import type { RowSecurityPlanInput, TenantTable } from './row-security-plan';
import { sqlType } from './sql-type';

/** One tenant table as `@ultimat3/entity`'s `describeTenancy()` names it: physical names only. */
export interface TenantColumnLike {
  readonly table: string;
  readonly column: string;
}

/** `GenerateOptions.rowSecurity`: `database.rowSecurity`, and which column each tenant table is scoped by. */
export interface RowSecurityOption {
  readonly enabled: boolean;
  readonly tenants: readonly TenantColumnLike[];
}

const OFF: RowSecurityOption = { enabled: false, tenants: [] };

/**
 * Tenant tables this migration still declares, typed by the SQL the generator itself gives the
 * column — one spelling of the type for the column and the policy's cast. A recorded table this
 * migration drops is left out of `recorded`: `drop table` takes its policy with it, and a
 * `drop policy` after that would name a table that no longer exists.
 */
export function rowSecurityInput(
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
  option: RowSecurityOption = OFF,
): RowSecurityPlanInput {
  const declared = new Map(entities.map((entity) => [entity.table, entity]));
  const tenantTables = option.tenants.flatMap((tenant): TenantTable[] => {
    const column = declared.get(tenant.table)?.columns.find((c) => c.column === tenant.column);
    return column === undefined
      ? []
      : [{ table: tenant.table, column: tenant.column, type: sqlType(column.kind) }];
  });
  const recorded = new Set(
    current.tables
      .filter((table) => table.rowSecurity === true && declared.has(table.name))
      .map((table) => table.name),
  );
  return { enabled: option.enabled, tenantTables, recorded };
}
