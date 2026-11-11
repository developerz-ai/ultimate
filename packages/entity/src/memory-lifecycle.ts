// Single responsibility: the memory driver's half of the lifecycle triggers — a history row per row
// change, a counter moved per child change — so a unit test answers what Postgres answers. Called
// by `memoryRepo` at each place a stored row changes, with the row before and after.

import { tryUseContext } from '@ultimat3/core';
import { entityNow } from './clock';
import { columnName, moneyColumns } from './column';
import { countersOf, countersTargeting } from './counter';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import { historyIgnored } from './history';
import type { MemoryTables } from './memory-same-tenant';
import type { Tx } from './repo';

const field = (row: unknown, property: string): unknown =>
  typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[property] : undefined;

const jsonValue = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : value === undefined ? null : value;

/** The stored row as `to_jsonb` spells it: physical names, money as its columns. */
export function imageOf(entity: EntityCore, row: unknown): Record<string, unknown> {
  const image = new Map<string, unknown>();
  for (const [property, column] of Object.entries(entity.$columns)) {
    const value = field(row, property);
    if (column.$meta.kind !== 'money') {
      image.set(columnName(property, column.$meta), jsonValue(value));
      continue;
    }
    const parts = moneyColumns(property, column.$meta);
    image.set(parts.minor, jsonValue(field(value, 'minor')));
    image.set(parts.currency, jsonValue(field(value, 'currency')));
    if (parts.scale !== null) image.set(parts.scale, jsonValue(field(value, 'scale')));
  }
  return Object.fromEntries(image);
}

const live = (entity: EntityCore, row: unknown): boolean =>
  !entity.$softDelete || field(row, SOFT_DELETE_COLUMN) == null;

/** What one change does to the tables beside it. `undefined` before is an insert, after a delete. */
export function memoryLifecycle(
  entity: EntityCore,
  tables: MemoryTables,
): (before: unknown, after: unknown, tx: Tx | undefined) => void {
  return (before, after, tx) => {
    const undo = (fn: () => void): void => tx?.onRollback(fn);
    for (const counter of countersTargeting(entity.$name)) {
      const parent = tables.get(counter.parent.$name);
      const key = counter.parent.$primaryKey[0] ?? '';
      const move = (row: unknown, delta: number): void => {
        const id = field(row, counter.references);
        if (row === undefined || id == null || !live(entity, row)) return;
        const stored = parent?.find(key, id);
        if (stored === undefined) return;
        const count = Number(field(stored, counter.column) ?? 0) + delta;
        parent?.raw?.replace(stored, { ...(stored as object), [counter.column]: count }, undo);
      };
      move(before, -1);
      move(after, 1);
    }
    const history = entity.$history;
    const target = history === null ? undefined : tables.get(history.$name);
    if (history === null || target?.raw === undefined) return;
    const prior = before === undefined ? null : imageOf(entity, before);
    const next = after === undefined ? null : imageOf(entity, after);
    const counted = new Set([...countingColumns(entity), ...historyIgnored(history)]);
    if (prior !== null && next !== null && sameIgnoring(prior, next, counted)) return;
    const source = after ?? before;
    const ctx = tx === undefined ? undefined : tryUseContext();
    const tenant = entity.$tenantColumn;
    target.raw.store(
      {
        id: crypto.randomUUID(),
        ...(tenant === null ? {} : { [tenant]: field(source, tenant) }),
        rowId: String(field(source, entity.$primaryKey[0] ?? '')),
        op: before === undefined ? 'insert' : after === undefined ? 'delete' : 'update',
        at: entityNow(),
        actorId: ctx?.actor.id ?? null,
        requestId: ctx?.requestId ?? null,
        before: prior,
        after: next,
      },
      undo,
    );
  };
}

/** The parent's counting columns: their change alone records no history, as in the trigger. */
const countingColumns = (entity: EntityCore): readonly string[] =>
  countersOf(entity).map((counter) => {
    const column = entity.$columns[counter.column];
    return column === undefined ? counter.column : columnName(counter.column, column.$meta);
  });

function sameIgnoring(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignored: ReadonlySet<string>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}
