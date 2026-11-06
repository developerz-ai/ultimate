// Single responsibility: the two facts a partitioned table changes about the schema dump — the
// order its tables load in (parent before partition, every one in the ROOT's file) and the index
// definition its parent's index can be rebuilt from. Pure; `schema-dump.ts` places the statements.

import type { CatalogTable } from './catalog';

/** A table and the file it is written to: its own, or its partition root's. */
export interface PlacedTable {
  readonly table: CatalogTable;
  readonly file: string;
}

/**
 * Every table once, each partition after the table it is a partition of, and filed under its root
 * — so `04_tables/events.sql` creates `events` and then each month, whatever the months are
 * called. Name order would create `a_2026_11` before `events`. A partition whose parent is not in
 * the list (another schema's) is filed under itself, after every family.
 */
export function inLoadOrder(tables: readonly CatalogTable[]): readonly PlacedTable[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const children = new Map<string, CatalogTable[]>();
  for (const table of tables) {
    const parent = table.partitionOf?.table;
    if (parent === undefined || !byName.has(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(table);
    children.set(parent, siblings);
  }
  const placed: PlacedTable[] = [];
  const seen = new Set<string>();
  const family = (root: CatalogTable): void => {
    // Breadth first: a sub-partition comes after every partition of the level above it.
    const queue = [root];
    for (let at = 0; at < queue.length; at += 1) {
      const table = queue[at];
      if (table === undefined || seen.has(table.name)) continue;
      seen.add(table.name);
      placed.push({ table, file: root.name });
      queue.push(...(children.get(table.name) ?? []));
    }
  };
  for (const table of tables) {
    const parent = table.partitionOf?.table;
    if (parent === undefined || !byName.has(parent)) family(table);
  }
  return placed;
}

/**
 * `pg_get_indexdef` spells a partitioned table's index `ON ONLY` — the form that builds the
 * parent's index alone, INVALID until every partition's is attached. The dump renders no
 * partition's attached index, so it loads the parent's without `ONLY`, which builds them all.
 */
const ON_ONLY = /^(CREATE (?:UNIQUE )?INDEX (?:"(?:[^"]|"")*"|\S+) ON )ONLY /;

export const indexDefinitionOf = (definition: string): string => definition.replace(ON_ONLY, '$1');
