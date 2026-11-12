// The indexes nobody declares, and the ONE rule for when one is already served: `(tenant, primary
// key)` — the shape of every scoped read, `where org_id = $1 order by id` — and each column's own
// index (`.references()`, `.index()`), which another index leading with that column makes a second
// copy every write pays for (`coveringIndexOf`, E9).

import { indexName } from './index-name';
import type { CoveredIndex, ReferenceDescription, RegistryEntry } from './registry';
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
   * Every index the table already has that can serve a prefix (`coverersOf`). One that STARTS
   * with `(tenant, pk…)` serves the scoped read already.
   */
  readonly covering: readonly IndexCoverer[];
}

/** An index whose leading key columns can serve a lookup: a name to report, physical columns. */
export interface IndexCoverer {
  readonly name: string;
  readonly columns: readonly string[];
}

/** What `coverersOf` reads off a declared index — structural, so every index shape fits. */
interface PrefixCandidate {
  readonly name: string;
  readonly columns: readonly string[];
  readonly where?: string | undefined;
  readonly using?: string | undefined;
  readonly expression?: string | undefined;
  readonly operatorClass?: string | undefined;
}

const startsWith = (list: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 &&
  prefix.length <= list.length &&
  prefix.every((column, at) => list[at] === column);

/**
 * THE covering rule, the one every implicit index is judged by: the first coverer whose key
 * columns START with `columns`. A btree serves an equality on any leading prefix of its keys, so
 * `(a)` beside `(a, b)` is the same lookup kept twice. Direction is irrelevant to that equality.
 */
export const coveringIndexOf = (
  columns: readonly string[],
  coverers: readonly IndexCoverer[],
): IndexCoverer | undefined => coverers.find((coverer) => startsWith(coverer.columns, columns));

/**
 * The indexes that can serve a prefix: the primary key (Postgres names it `<table>_pkey`), every
 * total btree keyed on plain columns, and every total unique invariant. A partial index misses
 * the rows its predicate excludes; a gin, an expression key or an operator class answers other
 * questions than `col = $1`.
 */
export const coverersOf = (
  table: string,
  primaryKey: readonly string[],
  indexes: readonly PrefixCandidate[],
  uniques: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly where?: string | undefined;
  }[],
): readonly IndexCoverer[] => [
  { name: `${table}_pkey`, columns: primaryKey },
  ...indexes.filter(
    (index) =>
      index.where == null &&
      (index.using === undefined || index.using === 'btree') &&
      index.expression === undefined &&
      index.operatorClass === undefined,
  ),
  ...uniques.filter((unique) => unique.where == null),
];

/**
 * Each implicit index another index already leads with, and which one. LISTED, never removed: on
 * `main` an existing app's description must keep it, or its next `x db gen` drops an index the
 * database holds (`index-plan.ts` `removeUndeclared`). The consumers report and drop on request.
 */
export const coveredImplicitIndexes = (
  implicit: readonly IndexCoverer[],
  coverers: readonly IndexCoverer[],
): readonly CoveredIndex[] =>
  implicit.flatMap((index) => {
    const by = coveringIndexOf(
      index.columns,
      coverers.filter((coverer) => coverer.name !== index.name),
    );
    return by === undefined
      ? []
      : [{ name: index.name, columns: index.columns, coveredBy: by.name }];
  });

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
  if (coveringIndexOf(columns, input.covering) !== undefined) return [];
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
