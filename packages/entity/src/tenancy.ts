// Multi-tenancy is a guard, not a convention. An entity with an `orgId` column can
// only be queried through a plan that carries an org predicate; building one without
// it throws `X_TENANCY_UNSCOPED` at the seam instead of leaking another tenant's rows.
import { tenancyUnscoped } from './errors';
import type { TableDef } from './types';

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

export interface QueryPlan {
  readonly entity: string;
  readonly where: readonly Predicate[];
  readonly orderBy: readonly { readonly column: string; readonly direction: SortDirection }[];
  readonly limit: number;
  readonly cursor?: string;
}

export const ORG_COLUMN = 'orgId';

/** True when the table declares an `orgId` column — presence is the switch. */
export const isOrgScoped = (table: TableDef): boolean => Object.hasOwn(table.columns, ORG_COLUMN);

export const emptyPlan = (entity: string, limit = 50): QueryPlan => ({
  entity,
  where: [],
  orderBy: [],
  limit,
});

export const hasOrgPredicate = (plan: QueryPlan): boolean =>
  plan.where.some((predicate) => predicate.column === ORG_COLUMN);

/** Adds the org predicate exactly once; calling it twice is not an error. */
export const orgScoped = (plan: QueryPlan, orgId: string): QueryPlan =>
  hasOrgPredicate(plan)
    ? plan
    : { ...plan, where: [...plan.where, { column: ORG_COLUMN, op: 'eq', value: orgId }] };

/**
 * Called by every repository operation. Runtime here, and a build-time check in
 * `x verify` that no query for a tenant-scoped entity is constructed without it.
 */
export const assertScoped = (
  entityName: string,
  table: TableDef,
  operation: string,
  plan: QueryPlan,
): void => {
  if (!isOrgScoped(table)) return;
  if (hasOrgPredicate(plan)) return;
  throw tenancyUnscoped(entityName, operation);
};

/** Debug/`x db explain` rendering. Values stay out: a plan is safe to log. */
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
