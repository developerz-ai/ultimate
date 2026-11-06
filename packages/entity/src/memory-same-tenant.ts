// Single responsibility: the memory driver's half of a same-tenant key. A target found under another
// tenant is refused with the code Postgres answers the composite key with. A target not found stays
// accepted: this driver enforces no foreign key at all, and starting would break every parent-less
// fixture. Postgres answers absent and foreign identically, so nothing here can tell them apart.

import { driverError, sameTenantKeyName } from '@ultimat3/db';
import { keyOf } from './batch-read';
import { kindOf, valueAt } from './cursor';
import { describeReferences } from './describe';
import type { EntityCore } from './entity';
import type { ReferenceDescription } from './registry';

/** One repository's rows as a neighbour may look at them: unscoped, because a guard is reading. */
export interface MemoryTable {
  readonly entity: EntityCore;
  /** The stored row whose `property` holds `value`, or `undefined`. */
  find(property: string, value: unknown): unknown;
  /**
   * A trigger's write, below every seam as the statement inside a Postgres trigger is: store `row`
   * as given, or replace the stored `before` with `after`. `memory-lifecycle.ts` is the one caller.
   */
  readonly raw?: {
    store(row: unknown, undo: (fn: () => void) => void): void;
    replace(before: unknown, after: unknown, undo: (fn: () => void) => void): void;
  };
}

/** One per driver, keyed by entity name: what a reference names (`Binding.table`). */
export type MemoryTables = Map<string, MemoryTable>;

/** Spelled the way Postgres would, so a uuid written in capitals is still the same row. */
const sameCell = (kind: string | undefined, left: unknown, right: unknown): boolean =>
  keyOf(kind ?? '', left) === keyOf(kind ?? '', right);

const inBatch = (
  batch: readonly unknown[],
  owner: EntityCore,
  property: string,
  value: unknown,
): unknown => batch.find((row) => sameCell(kindOf(owner, property), valueAt(row, property), value));

/**
 * The judge for one entity. The references are read on the first write and kept: a thunk cannot be
 * answered at declaration, and a write is the one moment both schema modules have evaluated.
 */
export const sameTenantJudge = <Row>(
  entity: EntityCore<Row>,
  tables: MemoryTables,
): ((row: Row, batch?: readonly Row[]) => void) => {
  let edges: readonly ReferenceDescription[] | undefined;
  const own = entity as EntityCore;
  return (row, batch = []) => {
    const tenant = entity.$tenantColumn;
    if (tenant === null) return;
    edges ??= describeReferences(entity.$name, Object.entries(entity.$columns)).filter(
      (edge) => edge.sameTenant !== null,
    );
    const rowTenant = valueAt(row, tenant);
    if (rowTenant === null || rowTenant === undefined) return;
    for (const edge of edges) {
      const value = valueAt(row, edge.property);
      if (value === null || value === undefined) continue;
      const table = tables.get(edge.targetEntity);
      if (table === undefined) continue;
      const target = table.entity;
      const targetTenant = target.$tenantColumn;
      if (targetTenant === null) continue;
      const found =
        table.find(edge.targetProperty, value) ??
        (target.$name === entity.$name
          ? inBatch(batch, own, edge.targetProperty, value)
          : undefined);
      if (found === undefined) continue;
      if (sameCell(kindOf(target, targetTenant), valueAt(found, targetTenant), rowTenant)) continue;
      const constraint = sameTenantKeyName(entity.$table, edge.column);
      throw driverError(`memory write into ${entity.$table}`, {
        code: '23503',
        constraint,
        message: `insert or update on table "${entity.$table}" violates foreign key constraint "${constraint}"`,
      });
    }
  };
};
