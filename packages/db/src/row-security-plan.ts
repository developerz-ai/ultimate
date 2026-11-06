// Single responsibility: what `x db gen` emits when `database.rowSecurity` flips — the policy on
// every tenant table, both directions, on the precedent of `generate-append-only.ts`. Pure over
// its inputs: which tables declare a tenant, and which already carry a recorded policy.

import type { Plan } from './foreign-key-plan';
import { dropRowSecuritySql, enableRowSecuritySql } from './row-security';
import { identifier } from './sql';

/** A table declaring `tenant:`, its tenant column's physical name, and that column's SQL type. */
export interface TenantTable {
  readonly table: string;
  readonly column: string;
  readonly type: string;
}

export interface RowSecurityPlanInput {
  /** `database.rowSecurity`. Off removes every recorded policy; on adds every missing one. */
  readonly enabled: boolean;
  readonly tenantTables: readonly TenantTable[];
  /** Tables the latest snapshot records as carrying the policy. */
  readonly recorded: ReadonlySet<string>;
  /** The migrator role the app role's grants are issued from, or none (grants left to the operator). */
  readonly appRole?: string | undefined;
}

/**
 * Up: enable, force, policy, and the app role's grants on each table that should carry one and is
 * not recorded; drop each recorded one that should not. Down reverses each. A table created in the
 * same migration needs no `down` of its own — its `down` is `drop table`, and this runs after it.
 * `x_*` tables declare no tenant and so are never here.
 */
export function rowSecurityPlan(plan: Plan, input: RowSecurityPlanInput): void {
  const wanted = new Set(input.enabled ? input.tenantTables.map((entry) => entry.table) : []);
  for (const entry of input.tenantTables) {
    if (!wanted.has(entry.table) || input.recorded.has(entry.table)) continue;
    plan.up.push(...enableRowSecuritySql(entry.table, entry.column, entry.type));
    if (input.appRole !== undefined) {
      plan.up.push(
        `grant select, insert, update, delete on ${identifier(entry.table).text} to ${identifier(input.appRole).text};`,
      );
    }
    // `down` is reversed whole, so these run drop-policy first.
    plan.down.push(...[...dropRowSecuritySql(entry.table)].reverse());
  }
  for (const table of [...input.recorded].sort()) {
    if (wanted.has(table)) continue;
    const entry = input.tenantTables.find((candidate) => candidate.table === table);
    plan.up.push(...dropRowSecuritySql(table));
    if (entry !== undefined) {
      plan.down.push(...[...enableRowSecuritySql(entry.table, entry.column, entry.type)].reverse());
    }
  }
}

/** What the snapshot records after this migration: the tables that carry the policy. */
export function rowSecurityAfter(input: RowSecurityPlanInput): ReadonlySet<string> {
  return new Set(input.enabled ? input.tenantTables.map((entry) => entry.table) : []);
}
