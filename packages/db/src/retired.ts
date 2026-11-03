// Single responsibility: what `entity({ retired: [...] })` means to `x db gen`. A retired column has
// left the entity, so nothing in the new release reads it, and stays in the table and the snapshot,
// so the old release keeps working. Retiring writes a marker and no statement; the drop comes in a
// later migration, by the ordinary arm, which only then finds the column it may take.

import { columnCheckNameOf } from './check-ddl';
import type { EntityDescriptionLike } from './entity-shape';
import { foreignKeysOf, type Plan } from './foreign-key-plan';
import type { ColumnDescription, SchemaDescription, TableDescription } from './introspect';
import { findTable } from './introspect';
import { contractsMarker, retiresMarker, unretiresMarker } from './rolling';
import {
  retiredColumnReferenced,
  retiredColumnRequired,
  retiredNameUnknown,
} from './rolling-errors';
import { retiredKeyIndexes } from './same-tenant';
import { identifier } from './sql';

/** The names, as `retiresMarker` writes them: through `identifier()`, which refuses a quote. */
const bare = (name: string): string => identifier(name).text.slice(1, -1);

/** The line above a retired column's drop, which is what `retireAndContractPending` pairs up. */
export const contractsMarkerFor = (table: string, column: string): string =>
  contractsMarker(bare(table), bare(column));

/**
 * Refuse what cannot be retired, and mark what newly is. Marker-only by design: indexes, foreign
 * keys and the column's own CHECK stay until the drop takes them with the column.
 *
 * Also the way back: a retired column declared again gets a marker of its own, because the only
 * thing that moved is the snapshot and an empty `up` writes no file (`generateAppMigration`) — the
 * flag would stay on the record, and a later removal would read as retired when it never was.
 */
export function retirePlan(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  entities: readonly EntityDescriptionLike[],
): void {
  const pointedAt = new Set(
    entities
      .flatMap(foreignKeysOf)
      .filter((key) => key.referencedTable === entity.table)
      .flatMap((key) => key.referencedColumns),
  );
  const recorded = new Map(live.columns.map((column) => [column.name, column]));
  const declared = new Set(entity.columns.map((column) => column.column));
  for (const name of entity.retired ?? []) {
    const column = recorded.get(name);
    if (column === undefined || declared.has(name)) {
      throw retiredNameUnknown(entity.name, entity.table, name);
    }
    // Declared keys, not recorded ones: a key this same migration lets go is no obstacle.
    if (pointedAt.has(name)) throw retiredColumnReferenced(entity.name, entity.table, name);
    if (column.retired === true) continue;
    const fillable = column.nullable || column.default !== null || column.generated !== undefined;
    if (!fillable || live.primaryKey.includes(name)) {
      throw retiredColumnRequired(entity.name, entity.table, name);
    }
    plan.up.push(retiresMarker(bare(entity.table), bare(name)));
  }
  for (const column of live.columns) {
    if (column.retired === true && declared.has(column.name)) {
      plan.up.push(unretiresMarker(bare(entity.table), bare(column.name)));
    }
  }
}

function recordInTable(
  table: TableDescription,
  live: TableDescription,
  entity: EntityDescriptionLike,
): TableDescription {
  const names = new Set(entity.retired ?? []);
  const over = (columns: readonly string[]): boolean => columns.some((each) => names.has(each));
  const kept: ColumnDescription[] = live.columns
    .filter((column) => names.has(column.name))
    .map((column) => ({ ...column, retired: true }));
  const columns = [...table.columns, ...kept]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((column, index) => ({ ...column, position: index + 1 }));
  const checkNames = new Set([...names].map((name) => columnCheckNameOf(entity.table, name)));
  const checks = [
    ...(table.checks ?? []),
    ...(live.checks ?? []).filter((check) => checkNames.has(check.name)),
  ];
  return {
    ...table,
    columns,
    indexes: [...table.indexes, ...live.indexes.filter((index) => over(index.columns))],
    foreignKeys: [
      ...table.foreignKeys,
      ...live.foreignKeys.filter((key) => over(key.columns)),
    ].sort((a, b) => (a.name < b.name ? -1 : 1)),
    ...(checks.length === 0 ? {} : { checks }),
  };
}

/**
 * `snapshotOf` carried one step on: what declarations alone cannot say, read off the recorded
 * schema. One function for both readers, `x db gen` and the `drift` step, because the second asks
 * whether the first would write anything: two answers would be drift on a correct app.
 */
export function recordRetired(
  snapshot: SchemaDescription,
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): SchemaDescription {
  const retiring = new Map(
    entities
      .filter((entity) => (entity.retired ?? []).length > 0)
      .map((entity) => [entity.table, entity]),
  );
  if (retiring.size === 0) return snapshot;
  const keptIndexes = retiredKeyIndexes(entities, current);
  return {
    ...snapshot,
    tables: snapshot.tables.map((recorded) => {
      const known = new Set(recorded.indexes.map((index) => index.name));
      const kept = (keptIndexes.get(recorded.name) ?? []).filter((index) => !known.has(index.name));
      const table =
        kept.length === 0 ? recorded : { ...recorded, indexes: [...recorded.indexes, ...kept] };
      const entity = retiring.get(table.name);
      const live = findTable(current, table.name);
      return entity === undefined || live === undefined
        ? table
        : recordInTable(table, live, entity);
    }),
  };
}
