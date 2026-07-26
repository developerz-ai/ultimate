// Multi-tenancy is a guard, not a convention. An entity with a tenant column can only be read
// through a plan that carries an org predicate; building one without it throws
// `X_TENANCY_UNSCOPED` at the seam instead of leaking another tenant's rows.

import { tenancyUnscoped } from './errors';
import type { ColumnMap } from './types';

export type Operator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'is-null'
  | 'is-not-null';

export interface Predicate {
  readonly column: string;
  readonly op: Operator;
  readonly value?: unknown;
}

export type SortDirection = 'asc' | 'desc';

export interface SortKey {
  readonly column: string;
  readonly direction: SortDirection;
}

export interface QueryPlan {
  readonly entity: string;
  readonly where: readonly Predicate[];
  readonly orderBy: readonly SortKey[];
  readonly limit: number;
  /** Keyset position. There is no `offset` and there will not be one — see `repo.ts`. */
  readonly cursor?: string;
  readonly select?: readonly string[];
}

/** The property key a tenant column takes when it is not marked explicitly. */
export const ORG_COLUMN = 'orgId';

/**
 * `.tenant()` is the switch; a column literally named `orgId` counts too, so an entity cannot
 * become unscoped by forgetting one call.
 */
export const tenantColumnOf = (columns: ColumnMap): string | null => {
  for (const [property, column] of Object.entries(columns)) {
    if (column.$meta.tenant) return property;
  }
  return Object.hasOwn(columns, ORG_COLUMN) ? ORG_COLUMN : null;
};

export const isOrgScoped = (columns: ColumnMap): boolean => tenantColumnOf(columns) !== null;

export const emptyPlan = (entity: string, limit = 50): QueryPlan => ({
  entity,
  where: [],
  orderBy: [],
  limit,
});

export const hasOrgPredicate = (plan: QueryPlan, column: string = ORG_COLUMN): boolean =>
  plan.where.some((predicate) => predicate.column === column);

/** Adds the org predicate exactly once; calling it twice is not an error. */
export const orgScoped = (
  plan: QueryPlan,
  orgId: string,
  column: string = ORG_COLUMN,
): QueryPlan =>
  hasOrgPredicate(plan, column)
    ? plan
    : { ...plan, where: [...plan.where, { column, op: 'eq', value: orgId }] };

/**
 * Called by every repository operation. Runtime here, and a build-time check in `x verify`
 * that no query for a tenant-scoped entity is constructed without it.
 */
export const assertScoped = (
  entityName: string,
  tenantColumn: string | null,
  operation: string,
  plan: QueryPlan,
): void => {
  if (tenantColumn === null) return;
  if (hasOrgPredicate(plan, tenantColumn)) return;
  throw tenancyUnscoped(entityName, operation);
};

/** Debug and `x db explain` rendering. Values stay out: a plan is safe to log. */
export const describePlan = (plan: QueryPlan): string => {
  const where = plan.where
    .map((predicate) => `${predicate.column} ${predicate.op} ?`)
    .join(' and ');
  const order = plan.orderBy.map((entry) => `${entry.column} ${entry.direction}`).join(', ');
  return [
    `from ${plan.entity}`,
    where === '' ? null : `where ${where}`,
    order === '' ? null : `order by ${order}`,
    `limit ${plan.limit}`,
    plan.cursor === undefined ? null : 'after cursor',
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
};
