// Single responsibility: turn repository arguments into the `QueryPlan` a driver executes.
// It sits outside both drivers because memory and Postgres must agree on what a call means —
// which rows are in scope, what the total sort order is, how big a page is. A guard only one
// driver applies is worse than none: the test passes and production leaks another tenant's rows.

import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { FindManyArgs, RepoOptions } from './repo';
import type { Predicate, QueryPlan } from './tenancy';
import { assertScoped } from './tenancy';

/** A page is bounded by default; an unbounded read is a production incident waiting for traffic. */
export const DEFAULT_PAGE_SIZE = 50;

/** Id-addressed operations need exactly one key. A composite key is a `findMany({ where })`. */
export const singleKeyOf = <Row>(entity: EntityCore<Row>, operation: string): string => {
  const [only] = entity.$primaryKey;
  if (entity.$primaryKey.length !== 1 || only === undefined) {
    throw invariantViolated(
      entity.$name,
      operation,
      `${entity.$name} has a composite primary key (${entity.$primaryKey.join(', ')}) — ` +
        'use findMany({ where }) instead of an id',
    );
  }
  return only;
};

export const planFor = <Row>(entity: EntityCore<Row>, args: FindManyArgs): QueryPlan => {
  const scoped =
    args.orgId === undefined || entity.$tenantColumn === null
      ? []
      : [{ column: entity.$tenantColumn, op: 'eq', value: args.orgId } satisfies Predicate];
  const ordered = args.orderBy ?? [];
  return {
    entity: entity.$name,
    where: [...(args.where ?? []), ...scoped],
    // The primary key is always the final sort key: a cursor needs a total order, or two
    // rows with the same sort value straddle a page boundary.
    orderBy: [
      ...ordered,
      ...entity.$primaryKey
        .filter((property) => !ordered.some((entry) => entry.column === property))
        .map((property) => ({ column: property, direction: 'asc' as const })),
    ],
    limit: args.limit ?? DEFAULT_PAGE_SIZE,
    ...(args.cursor === undefined || args.cursor === null ? {} : { cursor: args.cursor }),
    ...(args.select === undefined ? {} : { select: args.select }),
  };
};

/** The plan for a read. Throws `X_TENANCY_UNSCOPED` before a single row is considered. */
export const readPlan = <Row>(
  entity: EntityCore<Row>,
  args: FindManyArgs,
  operation: string,
): QueryPlan => {
  const plan = planFor(entity, args);
  assertScoped(entity.$name, entity.$tenantColumn, operation, plan);
  return plan;
};

/**
 * The plan for an id-addressed write. A write is a query too: without the same guard,
 * `update(id, patch)` on a tenant-scoped entity is a cross-tenant write that no read path
 * would ever have allowed.
 */
export const idPlan = <Row>(
  entity: EntityCore<Row>,
  id: string,
  options: RepoOptions | undefined,
  operation: string,
): QueryPlan =>
  readPlan(
    entity,
    {
      ...options,
      where: [{ column: singleKeyOf(entity, operation), op: 'eq', value: id }],
      limit: 1,
    },
    operation,
  );
