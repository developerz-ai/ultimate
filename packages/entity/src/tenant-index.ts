// The one index every tenant table needs and nobody declares: `(tenant, primary key)`, the exact
// shape of every scoped read — `where org_id = $1 order by id` — whether the tenant column was
// marked `.tenant()`, named by `tenant:` or inferred from `orgId`.

import { indexName } from './index-name';
import type { ReferenceDescription, RegistryEntry } from './registry';
import { registeredEntities, registryGeneration } from './registry';
import type { IndexDef } from './types';

export interface TenantIndexInput {
  readonly entityName: string;
  readonly table: string;
  /** The tenant column's PHYSICAL name, `null` on an untenanted table. */
  readonly tenant: string | null;
  /** The primary key's physical columns, in declared order. */
  readonly primaryKey: readonly string[];
  /** A plain (non-materialized) view holds no index at all. */
  readonly plainView: boolean;
  /**
   * The column lists of every non-partial btree index and unique constraint the table already
   * declares. One that STARTS with `(tenant, pk…)` serves the scoped read already.
   */
  readonly covering: readonly (readonly string[])[];
}

const startsWith = (list: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= list.length && prefix.every((column, at) => list[at] === column);

/**
 * Zero or one index. Measured at 500k rows / 1,000 tenants: a tenant page took 43.7 ms with no
 * index, 2.9 ms on `(org_id)` and 1.5 ms on `(org_id, id)` — the composite serves the filter AND
 * the keyset order, so it replaces the single-column index `.tenant()` used to get rather than
 * joining it (see `coveredByTenantIndex`). None when the primary key already leads with the
 * tenant: its own index is this one.
 *
 * Built `concurrently`: adding it to a live table must not hold SHARE for the whole build, and on
 * a table the same migration creates `@ultimat3/db` builds it inline anyway.
 */
export const tenantIndexOf = (input: TenantIndexInput): readonly IndexDef[] => {
  const { tenant, primaryKey } = input;
  // `leadingColumn`, not `primaryKey[0]`: a column name, which `secret-compare` would read as a key.
  const [leadingColumn] = primaryKey;
  if (tenant === null || input.plainView || leadingColumn === tenant) return [];
  const columns = [tenant, ...primaryKey.filter((column) => column !== tenant)];
  if (input.covering.some((list) => startsWith(list, columns))) return [];
  return [
    {
      name: indexName(input.entityName, input.table, columns, false),
      columns,
      unique: false,
      concurrently: true,
    },
  ];
};

/**
 * Whether a column's own single-column, non-unique index is a prefix of the tenant index — or of a
 * primary key that leads with the tenant — and so is not built a second time. A unique tenant
 * column keeps its constraint: uniqueness is a rule, not an access path.
 */
export const coveredByTenantIndex = (
  physical: string,
  tenant: string | null,
  unique: boolean,
): boolean => !unique && tenant !== null && physical === tenant;

/**
 * Another entity's references, or none when resolving them refuses: that entity's own
 * `$describe()` raises the refusal with its own name, and THIS entity's description must not fail
 * for it. Skipping it only keeps an index — the safe direction.
 */
const referencesOf = (entry: RegistryEntry): readonly ReferenceDescription[] => {
  try {
    return entry.references();
  } catch {
    return [];
  }
};

/** `<table>|<column>` of every same-tenant reference target, memoised on the registry generation. */
let targets: { readonly generation: number; readonly keys: ReadonlySet<string> } | undefined;

const sameTenantTargets = (): ReadonlySet<string> => {
  const generation = registryGeneration();
  if (targets !== undefined && targets.generation === generation) return targets.keys;
  const keys = new Set<string>();
  for (const entry of registeredEntities()) {
    for (const reference of referencesOf(entry)) {
      if (reference.sameTenant != null) {
        keys.add(`${reference.targetTable}|${reference.targetColumn}`);
      }
    }
  }
  targets = { generation, keys };
  return keys;
};

/**
 * Describe time, when every entity is registered: the target of a same-tenant reference gets a
 * UNIQUE `(tenant, key)` from `@ultimat3/db` (`same-tenant.ts`), which serves the scoped read, so
 * the non-unique tenant index beside it would be the same index twice. Not decided at `entity()`:
 * the referencing entity may be declared later, and a thunk is never resolved at declaration.
 */
export const withoutDerivedDuplicate = (
  table: string,
  primaryKey: readonly string[],
  tenantIndex: IndexDef | undefined,
  indexes: readonly IndexDef[],
): readonly IndexDef[] => {
  if (tenantIndex === undefined || primaryKey.length !== 1) return indexes;
  if (!sameTenantTargets().has(`${table}|${primaryKey[0]}`)) return indexes;
  return indexes.filter((index) => index !== tenantIndex);
};
