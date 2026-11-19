// Single responsibility: the running answer to "what has this chain built so far", one migration at
// a time: an `up`'s events take objects away, its sidecar adds what it records. `migration-fork.ts`
// reads the result.

import type {
  CheckDescription,
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  SchemaDescription,
  TableDescription,
  ViewDescription,
} from './introspect';
import type { ForkCollision, ForkObjectKind } from './migration-fork';
import type { ForkEvent } from './migration-fork-sql';
import { nameOf, tokensOf } from './rolling';

export interface Fold {
  readonly tables: Map<string, TableDescription>;
  readonly views: Map<string, ViewDescription>;
  readonly recordedBy: Map<string, string>;
  /** Tables and columns only: an index's `create` may sit in a later concurrent step. */
  readonly gone: Map<string, string>;
  readonly collisions: ForkCollision[];
}

export const key = (kind: ForkObjectKind, table: string, name: string): string =>
  `${kind}\0${table}\0${name}`;

export const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const withoutNamed = <T extends { readonly name: string }>(
  items: readonly T[],
  name: string,
): readonly T[] => items.filter((item) => item.name !== name);

function dropConstraint(table: TableDescription, name: string): TableDescription {
  return {
    ...table,
    indexes: withoutNamed(table.indexes, name),
    foreignKeys: withoutNamed(table.foreignKeys, name),
    ...(table.checks === undefined ? {} : { checks: withoutNamed(table.checks, name) }),
  };
}

/** Postgres takes an index, key or check over a dropped column with it, and writes no statement. */
function dropColumn(table: TableDescription, column: string): TableDescription {
  return {
    ...table,
    columns: withoutNamed(table.columns, column),
    indexes: table.indexes.filter((index) => !index.columns.includes(column)),
    foreignKeys: table.foreignKeys.filter((foreign) => !foreign.columns.includes(column)),
    ...(table.checks === undefined
      ? {}
      : {
          checks: table.checks.filter(
            (check) => !tokensOf(check.expression).map(nameOf).includes(column),
          ),
        }),
  };
}

function dropTable(fold: Fold, table: string, id: string): void {
  fold.tables.delete(table);
  fold.gone.set(key('table', table, table), id);
  for (const [name, other] of fold.tables) {
    fold.tables.set(name, {
      ...other,
      foreignKeys: other.foreignKeys.filter((foreign) => foreign.referencedTable !== table),
    });
  }
}

function collide(
  fold: Fold,
  kind: 'table' | 'column',
  table: string,
  name: string,
  again: string,
): void {
  const first = fold.recordedBy.get(key(kind, table, name)) ?? again;
  fold.collisions.push({ kind, table, name, first, again });
}

function createTable(
  fold: Fold,
  event: Extract<ForkEvent, { op: 'create-table' }>,
  id: string,
): void {
  if (!event.guarded && fold.tables.has(event.table)) {
    collide(fold, 'table', event.table, event.table, id);
  }
  fold.gone.delete(key('table', event.table, event.table));
  const columnsOf = key('column', event.table, '');
  for (const name of fold.gone.keys()) if (name.startsWith(columnsOf)) fold.gone.delete(name);
}

function addColumn(fold: Fold, event: Extract<ForkEvent, { op: 'add-column' }>, id: string): void {
  const held = fold.tables.get(event.table)?.columns.some((c) => c.name === event.column) === true;
  if (!event.guarded && held) collide(fold, 'column', event.table, event.column, id);
  fold.gone.delete(key('column', event.table, event.column));
}

function renameTable(fold: Fold, table: string, to: string, id: string): void {
  const held = fold.tables.get(table);
  dropTable(fold, table, id);
  if (held !== undefined) fold.tables.set(to, { ...held, name: to });
}

function mapTables(fold: Fold, change: (table: TableDescription) => TableDescription): void {
  for (const [name, table] of fold.tables) fold.tables.set(name, change(table));
}

export function apply(fold: Fold, event: ForkEvent, id: string): void {
  const altered = 'table' in event ? fold.tables.get(event.table) : undefined;
  switch (event.op) {
    case 'create-table':
      createTable(fold, event, id);
      return;
    case 'drop-table':
      dropTable(fold, event.table, id);
      return;
    case 'rename-table':
      renameTable(fold, event.table, event.to, id);
      return;
    case 'add-column':
      addColumn(fold, event, id);
      return;
    case 'drop-column':
      fold.gone.set(key('column', event.table, event.column), id);
      if (altered !== undefined) fold.tables.set(event.table, dropColumn(altered, event.column));
      return;
    case 'drop-constraint':
      if (altered !== undefined) fold.tables.set(event.table, dropConstraint(altered, event.name));
      return;
    case 'drop-index':
      mapTables(fold, (table) => ({
        ...table,
        indexes: withoutNamed(table.indexes, event.name),
      }));
      return;
    case 'drop-view':
      fold.views.delete(event.name);
  }
}

/** `next`, plus what only `held` has, in name order; `next` wins on a shared name. */
function union<T extends { readonly name: string }>(
  held: readonly T[],
  next: readonly T[],
): readonly T[] {
  const names = new Set(next.map((item) => item.name));
  const extra = held.filter((item) => !names.has(item.name));
  return extra.length === 0 ? next : [...next, ...extra].sort(byName);
}

/** Dense and alphabetical, what `snapshotOf` writes, whenever the merge changed the set. */
function mergedColumns(
  held: readonly ColumnDescription[],
  next: readonly ColumnDescription[],
): readonly ColumnDescription[] {
  const columns = union(held, next);
  return columns === next
    ? next
    : columns.map((column, index) => ({ ...column, position: index + 1 }));
}

function overlayTable(fold: Fold, next: TableDescription): TableDescription {
  const kept = next.columns.filter(
    (column) => !fold.gone.has(key('column', next.name, column.name)),
  );
  const stated = kept.length === next.columns.length ? next : { ...next, columns: kept };
  const held = fold.tables.get(next.name);
  if (held === undefined) return stated;
  const checks: readonly CheckDescription[] = union(held.checks ?? [], stated.checks ?? []);
  const indexes: readonly IndexDescription[] = union(held.indexes, stated.indexes);
  const foreignKeys: readonly ForeignKeyDescription[] = union(held.foreignKeys, stated.foreignKeys);
  return {
    ...stated,
    columns: mergedColumns(held.columns, stated.columns),
    indexes,
    foreignKeys,
    ...(checks.length === 0 ? {} : { checks }),
  };
}

export const partsOf = (table: TableDescription) =>
  [
    ['column', table.columns],
    ['index', table.indexes],
    ['foreign key', table.foreignKeys],
    ['check', table.checks ?? []],
  ] as const;

export function overlay(fold: Fold, snapshot: SchemaDescription, id: string): void {
  for (const next of snapshot.tables) {
    if (fold.gone.has(key('table', next.name, next.name))) continue;
    const table = overlayTable(fold, next);
    fold.tables.set(next.name, table);
    const tableKey = key('table', next.name, next.name);
    if (!fold.recordedBy.has(tableKey)) fold.recordedBy.set(tableKey, id);
    for (const [kind, items] of partsOf(table)) {
      for (const item of items) {
        const itemKey = key(kind, next.name, item.name);
        if (!fold.recordedBy.has(itemKey)) fold.recordedBy.set(itemKey, id);
      }
    }
  }
  for (const view of snapshot.views ?? []) {
    fold.views.set(view.name, view);
    const viewKey = key('view', view.name, view.name);
    if (!fold.recordedBy.has(viewKey)) fold.recordedBy.set(viewKey, id);
  }
}
