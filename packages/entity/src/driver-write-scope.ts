// Single responsibility: the two write-side guards a custom store cannot be trusted with. The rows a
// store hands back from a write are checked against the tenants the write named — a Mongo-style
// upsert answering the STORED document of a global unique hands over another tenant's row — and a
// same-tenant reference is judged by memory's own judge, over targets the kit looked up itself.

import { keyOf } from './batch-read';
import { kindOf, valueAt } from './cursor';
import { describeReferences } from './describe';
import { driverRowOutOfScope } from './driver-errors';
import type { DriverRepo } from './driver-kit-types';
import type { EntityCore } from './entity';
import { type MemoryTables, sameTenantJudge } from './memory-same-tenant';
import { getEntity } from './registry';
import { assertRowTenant } from './tenancy';

/** How the kit reaches another entity's raw store in the same driver. */
export type RawFor = <R>(entity: EntityCore<R>) => DriverRepo<R>;

const cell = (entity: EntityCore, property: string, value: unknown): string =>
  keyOf(kindOf(entity, property) ?? '', value);

/**
 * Every returned row names a tenant one of the WRITTEN rows named — or, where a written row named
 * none, passes the actor check `assertRowTenant` applies. Refused whole, never filtered.
 */
export const assertWrittenInScope = <Row>(
  driverName: string,
  entity: EntityCore<Row>,
  operation: string,
  written: readonly Row[],
  returned: readonly Row[],
): readonly Row[] => {
  const column = entity.$tenantColumn;
  if (column === null) return returned;
  const own = entity as EntityCore;
  const named = written.map((row) => valueAt(row, column));
  const allowed = new Set(
    named
      .filter((value) => value !== null && value !== undefined)
      .map((value) => cell(own, column, value)),
  );
  const anyUnnamed = named.some((value) => value === null || value === undefined);
  for (const row of returned) {
    const value = valueAt(row, column);
    if (value !== null && value !== undefined && allowed.has(cell(own, column, value))) continue;
    if (anyUnnamed) {
      assertRowTenant(entity.$name, column, operation, row);
      continue;
    }
    throw driverRowOutOfScope(driverName, entity.$name, operation, column);
  }
  return returned;
};

/** The properties holding a same-tenant reference — a patch naming one has to be judged. */
export const sameTenantProperties = <Row>(entity: EntityCore<Row>): ReadonlySet<string> =>
  entity.$tenantColumn === null
    ? new Set()
    : new Set(
        describeReferences(entity.$name, Object.entries(entity.$columns))
          .filter((edge) => edge.sameTenant !== null)
          .map((edge) => edge.property),
      );

/**
 * `sameTenantJudge` over a table of targets fetched first: each referenced value is read from the
 * target's store UNSCOPED — the judge has to find a target in another tenant to refuse it — and the
 * judge then answers exactly as it does for the memory driver (`X_DB_FOREIGN_KEY_VIOLATION`).
 */
export const sameTenantReferences = <Row>(entity: EntityCore<Row>, rawFor: RawFor) => {
  const judge = (tables: MemoryTables) => sameTenantJudge(entity, tables);
  return async (rows: readonly Row[]): Promise<void> => {
    if (entity.$tenantColumn === null || rows.length === 0) return;
    const edges = describeReferences(entity.$name, Object.entries(entity.$columns)).filter(
      (edge) => edge.sameTenant !== null,
    );
    if (edges.length === 0) return;
    const tables: MemoryTables = new Map();
    for (const edge of edges) {
      const target = getEntity(edge.targetEntity)?.core;
      if (target === undefined || target.$tenantColumn === null) continue;
      const values = [
        ...new Set(
          rows
            .map((row) => valueAt(row, edge.property))
            .filter((value) => value !== null && value !== undefined),
        ),
      ];
      if (values.length === 0) continue;
      const where = [{ column: edge.targetProperty, op: 'in' as const, value: values }];
      const orderBy = target.$primaryKey.map((column) => ({ column, direction: 'asc' as const }));
      const plan = { entity: target.$name, where, orderBy, limit: values.length };
      const found = await rawFor(target).select({ plan, after: undefined, limit: values.length });
      const prior = tables.get(target.$name);
      tables.set(target.$name, {
        entity: target,
        find: (property, value) =>
          found.find(
            (row) =>
              cell(target, property, valueAt(row, property)) === cell(target, property, value),
          ) ?? prior?.find(property, value),
      });
    }
    const verdict = judge(tables);
    for (const row of rows) verdict(row, rows);
  };
};
