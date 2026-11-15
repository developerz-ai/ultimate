// Single responsibility: which implicit indexes the app's entities describe that another index
// already serves (`RegistryEntry.coveredIndexes`), and the descriptions `x db gen` diffs with those
// left out — on `--drop-redundant`, and for good once a migration has dropped one.

import type { Migration, SchemaDescription } from '@ultimat3/db';
import { declaredSchema } from '@ultimat3/db';
import type { EntityDescription, RegistryEntry } from '@ultimat3/entity';

export interface RedundantIndex {
  readonly table: string;
  readonly name: string;
  /** Physical columns, in index order. */
  readonly columns: readonly string[];
  /** The index, primary key or unique invariant that already leads with them. */
  readonly coveredBy: string;
}

/** Every covered implicit index of the registry, in registry order. */
export const redundantIndexes = (entries: readonly RegistryEntry[]): readonly RedundantIndex[] =>
  entries.flatMap((entry) =>
    (entry.coveredIndexes ?? []).map((index) => ({
      table: entry.tableName,
      name: index.name,
      columns: index.columns,
      coveredBy: index.coveredBy,
    })),
  );

/** Each table the snapshot records, to the index names it holds. */
const recordedIndexes = (current: SchemaDescription): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    current.tables.map((table) => [table.name, new Set(table.indexes.map((index) => index.name))]),
  );

/**
 * The covered indexes still in the newest snapshot: what `--drop-redundant` would drop now. A
 * table the snapshot does not hold yet is left out — its first migration has not been written.
 */
export const pendingRedundant = (
  redundant: readonly RedundantIndex[],
  current: SchemaDescription,
): readonly RedundantIndex[] => {
  const recorded = recordedIndexes(current);
  return redundant.filter((index) => recorded.get(index.table)?.has(index.name) === true);
};

/**
 * Each table the newest snapshot holds, to the index names an EARLIER snapshot recorded on it and
 * the newest no longer does: what a migration dropped. Absent from the newest alone is not that —
 * a covered index newly declared on an existing table was never built.
 */
const droppedIndexes = (
  migrations: readonly Migration[],
  current: SchemaDescription,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const recorded = recordedIndexes(current);
  const dropped = new Map<string, Set<string>>();
  for (const migration of migrations) {
    for (const table of migration.snapshot?.tables ?? []) {
      const held = recorded.get(table.name);
      if (held === undefined) continue;
      for (const index of table.indexes) {
        if (held.has(index.name)) continue;
        dropped.set(table.name, (dropped.get(table.name) ?? new Set()).add(index.name));
      }
    }
  }
  return dropped;
};

/**
 * The descriptions to diff. A covered index on a table the newest snapshot holds is left out when
 * `drop` asks for it, or when a migration already dropped it — a plain `x db gen` rebuilding it
 * would undo that review. A NEW table, or a covered index never built, keeps every index:
 * dropping is never a default.
 */
export const settledDescriptions = (
  entries: readonly RegistryEntry[],
  migrations: readonly Migration[],
  drop: boolean,
): readonly EntityDescription[] => {
  const current = declaredSchema(migrations);
  if (current === undefined) return entries.map((entry) => entry.describe());
  const recorded = recordedIndexes(current);
  const dropped = droppedIndexes(migrations, current);
  return entries.map((entry) => {
    const description = entry.describe();
    const held = recorded.get(entry.tableName);
    const gone = dropped.get(entry.tableName);
    const left = new Set(
      (entry.coveredIndexes ?? [])
        .filter((index) => held !== undefined && (drop || gone?.has(index.name) === true))
        .map((index) => index.name),
    );
    if (left.size === 0) return description;
    return {
      ...description,
      indexes: description.indexes.filter((index) => !left.has(index.name)),
    };
  });
};
