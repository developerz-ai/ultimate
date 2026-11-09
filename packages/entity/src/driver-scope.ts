// Single responsibility: what every method of a `defineDriver` repository shares — the raw store,
// the capability check, the plan a store is handed (soft delete folded in, `select` and `cursor`
// taken out) and the scope check on every row a store hands back.

import { driverRowOutOfScope, driverUnsupported } from './driver-errors';
import type { DriverCapability, DriverDefinition, DriverRepo } from './driver-kit-types';
import { outOfScope, structuralPredicates } from './driver-rows';
import type { RawFor } from './driver-write-scope';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import type { Tx } from './repo';
import type { QueryPlan } from './tenancy';

export interface DriverScope<Row> {
  readonly definition: DriverDefinition;
  readonly entity: EntityCore<Row>;
  readonly raw: DriverRepo<Row>;
  /** Another entity's raw store in this driver — the one a same-tenant reference is read from. */
  readonly rawFor: RawFor;
  /** Refuses `X_DRIVER_UNSUPPORTED` unless the driver declared `capability`. */
  need(operation: string, capability: DriverCapability): void;
  /** The `tx` a write may carry: only a driver that declared `'transactions'` takes one. */
  txOf(operation: string, options: { readonly tx?: Tx } | undefined): Tx | undefined;
  /** The plan as the store sees it. `includeDeleted` is the caller's; writes never pass it. */
  storePlan(operation: string, plan: QueryPlan, includeDeleted?: boolean): QueryPlan;
  /** Every row a store returned, refused whole if one is out of the plan's scope. */
  checked(operation: string, plan: QueryPlan, rows: readonly Row[]): readonly Row[];
}

export const driverScope = <Row>(
  definition: DriverDefinition,
  entity: EntityCore<Row>,
  rawFor: RawFor,
): DriverScope<Row> => {
  const declared: ReadonlySet<DriverCapability> = new Set(definition.capabilities);
  const need = (operation: string, capability: DriverCapability): void => {
    if (!declared.has(capability)) {
      throw driverUnsupported(definition.name, entity.$name, operation, capability);
    }
  };
  return {
    definition,
    entity,
    raw: rawFor(entity),
    rawFor,
    need,
    txOf(operation, options) {
      if (options?.tx === undefined) return undefined;
      // A transaction from elsewhere promises atomicity this store cannot give: refused, not
      // ignored — an ignored tx is a rollback that silently keeps the write.
      need(operation, 'transactions');
      return options.tx;
    },
    storePlan(operation, plan, includeDeleted = false) {
      if (plan.where.some((predicate) => predicate.op === 'matches')) need(operation, 'matches');
      const hidden =
        entity.$softDelete && !includeDeleted
          ? [{ column: SOFT_DELETE_COLUMN, op: 'is-null' as const }]
          : [];
      return {
        entity: plan.entity,
        where: [...plan.where, ...hidden],
        orderBy: plan.orderBy,
        limit: plan.limit,
      };
    },
    checked(operation, plan, rows) {
      const structural = structuralPredicates(entity, plan, SOFT_DELETE_COLUMN);
      for (const row of rows) {
        const column = outOfScope(entity, structural, row);
        if (column !== undefined) {
          throw driverRowOutOfScope(definition.name, entity.$name, operation, column);
        }
      }
      return rows;
    },
  };
};
