// Single responsibility: the order a set of tables can be dropped in, and the foreign keys that
// have to go first when no order exists. `generate.ts` writes the statements; this file decides
// which of them may run when, because `drop table` is refused (`2BP01`) while anything still
// points at the table.

import { dropForeignKey } from './foreign-key';
import type { TableDescription } from './introspect';

export interface DropOrder {
  /** The tables, referencing before referenced. */
  readonly tables: readonly TableDescription[];
  /** `drop constraint` statements that must run BEFORE the first drop — cycles only. */
  readonly constraints: readonly string[];
}

function referencesFrom(table: TableDescription, target: string): readonly string[] {
  return table.foreignKeys
    .filter((key) => key.referencedTable === target)
    .map((key) => dropForeignKey(table.name, key.name));
}

/**
 * Drop the children first: a table nothing still-to-be-dropped points at is always safe to drop,
 * and removing it makes its own parents safe in turn. Alphabetical order — which is what
 * `SchemaDescription` carries — puts `authors` before `posts`, i.e. the parent first, which is the
 * one order Postgres refuses.
 *
 * A self-reference is never a blocker: `drop table` takes the table's OWN constraints with it, so
 * a tree table needs no `drop constraint` of its own.
 *
 * A cycle between two doomed tables has no safe order at all, so one of them is chosen and the
 * keys pointing at it are dropped first. That is the only case that emits a statement here — every
 * other inbound key belongs to a table that SURVIVES, which `generate.ts` handles beside the entity
 * that still owns the column.
 */
export function dropOrder(dropped: readonly TableDescription[]): DropOrder {
  const remaining = [...dropped];
  const tables: TableDescription[] = [];
  const constraints: string[] = [];
  while (remaining.length > 0) {
    const free = remaining.findIndex(
      (table) =>
        !remaining.some(
          (other) =>
            other.name !== table.name &&
            other.foreignKeys.some((key) => key.referencedTable === table.name),
        ),
    );
    const index = free === -1 ? 0 : free;
    const next = remaining[index] as TableDescription;
    if (free === -1) {
      for (const other of remaining) {
        if (other.name === next.name) continue;
        constraints.push(...referencesFrom(other, next.name));
      }
    }
    tables.push(next);
    remaining.splice(index, 1);
  }
  return { tables, constraints };
}
