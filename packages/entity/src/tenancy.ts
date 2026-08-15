// Multi-tenancy is a guard, not a convention. An entity with a tenant column is read under the
// ACTING ACTOR's tenant — derived from the ambient context, never taken from an argument — and a
// plan that names a different one is refused rather than answered.

import { tryUseContext } from '@ultimat3/core';
import { assertCrossTenant, crossTenantReason } from './cross-tenant';
import {
  EntityError,
  tenancyActorMismatch,
  tenancyActorOrgRequired,
  tenancyUnscoped,
} from './errors';
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

/**
 * `entity(name, { tenant: 'workspaceId' })` wins over inference — a tenant column need not be
 * called `orgId` and need not carry `.tenant()`. Omitting it keeps the inference, so an entity
 * cannot become unscoped by forgetting the key; naming a column that does not exist is a
 * declaration error, because the alternative is a silently unscoped table.
 */
export const resolveTenantColumn = (
  entityName: string,
  columns: ColumnMap,
  declared: string | undefined,
): string | null => {
  if (declared === undefined) return tenantColumnOf(columns);
  if (!Object.hasOwn(columns, declared)) {
    const available = Object.keys(columns).join(', ');
    // Not `invariantViolated`: its fix points at `x entity explain`, which describes invariants
    // the author never wrote. What repairs this is one edit to the declaration, so the error
    // carries that edit and both ways out of it.
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName}.tenant: tenant: '${declared}' names no column — pick from: ${available}`,
      fix: `set tenant to one of ${available} in entity('${entityName}'), or remove the tenant key — inference then takes the .tenant() column, else one named ${ORG_COLUMN}`,
    });
  }
  return declared;
};

export const emptyPlan = (entity: string, limit = 50): QueryPlan => ({
  entity,
  where: [],
  orderBy: [],
  limit,
});

/**
 * Whether the plan mentions the tenant column at all — never whether it mentions the right VALUE,
 * which is why this is not the guard. `scopedPlan` compares against the actor; this answers the
 * narrower question the derivation asks before it appends a predicate that already exists.
 */
export const hasOrgPredicate = (plan: QueryPlan, column: string = ORG_COLUMN): boolean =>
  plan.where.some((predicate) => predicate.column === column);

/**
 * Adds the org predicate exactly once; calling it twice is not an error. The explicit form of what
 * `scopedPlan` does from the actor — and inside a request it must name that same tenant, or the
 * plan is refused as `X_TENANCY_ACTOR_MISMATCH`. It adds a predicate; it never authorises one.
 */
export const orgScoped = (
  plan: QueryPlan,
  orgId: string,
  column: string = ORG_COLUMN,
): QueryPlan =>
  hasOrgPredicate(plan, column)
    ? plan
    : { ...plan, where: [...plan.where, { column, op: 'eq', value: orgId }] };

/**
 * The tenant every plan for a scoped entity runs under: the acting actor's own, or `undefined`
 * when there is no request context to take one from.
 *
 * An actor that carries no tenant is refused rather than allowed to name one — anonymous is the
 * case that must not read a tenant table by asking nicely, and a service actor minted without an
 * org is a boundary that forgot to resolve it. `crossTenant()` is the way to mean it on purpose.
 *
 * No context at all is a different situation and not a caller-reachable one: every entry point in
 * the framework runs its handler inside `runWithContext`, so this is a script, a boot path or a
 * test harness, with no identity to check a value against. Those callers still have to name the
 * tenant themselves — `verifyScope` refuses an unscoped plan exactly as it always did.
 */
const actorTenant = (entityName: string, operation: string): string | undefined => {
  const ctx = tryUseContext();
  if (ctx === undefined) return undefined;
  const { actor } = ctx;
  if (actor.orgId === undefined) {
    throw tenancyActorOrgRequired({
      entityName,
      operation,
      actorId: actor.id,
      actorKind: actor.kind,
    });
  }
  return actor.orgId;
};

/**
 * Every predicate on the tenant column has to be `eq` the actor's own tenant. Every one, and `eq`
 * only: `where('orgId', 'in', [mine, theirs])` names a tenant that is not the actor's just as
 * plainly as `where('orgId', 'eq', theirs)` does, and a plan carrying both predicates is answered
 * by the narrower of the two — so checking "one of them matches" would pass a plan whose rows come
 * from a set the actor never proved they own.
 */
const verifyScope = (
  entityName: string,
  tenantColumn: string,
  operation: string,
  plan: QueryPlan,
  actorOrg: string | undefined,
): void => {
  const named = plan.where.filter((predicate) => predicate.column === tenantColumn);
  // `actorOrg` goes in so the refusal states which of the two situations this is: `scopedPlan`
  // never reaches here with an actor (it derives first), but `assertScoped` verifies plans it did
  // not build, and telling that caller "no actor carried a tenant" would be false.
  if (named.length === 0) throw tenancyUnscoped(entityName, operation, actorOrg);
  if (actorOrg === undefined) return;
  for (const predicate of named) {
    if (predicate.op !== 'eq' || predicate.value !== actorOrg) {
      throw tenancyActorMismatch({ entityName, operation, named: predicate.value, actorOrg });
    }
  }
};

/**
 * The plan a tenant-scoped operation actually runs, with the actor's tenant applied. Called by
 * every repository operation through `readPlan`, so both drivers and every read, write and count
 * pass through this one derivation.
 *
 * Runtime only. There is no build-time tenancy step in `x verify` — its 17 steps check none — and
 * there cannot usefully be one: the tenant is a request-time value, so a compiler could only prove
 * that some argument was passed, which is exactly the thing that was never a guarantee. That is
 * why this is the seam every plan is built through rather than a lint.
 */
export const scopedPlan = (
  entityName: string,
  tenantColumn: string | null,
  operation: string,
  plan: QueryPlan,
): QueryPlan => {
  if (tenantColumn === null) return plan;
  const crossing = crossTenantReason();
  // Re-proved per plan, not trusted from the scope's own entry: `withChildContext({ actor })`
  // swaps the actor without closing the scope.
  if (crossing !== undefined) {
    assertCrossTenant(crossing);
    return plan;
  }
  const actorOrg = actorTenant(entityName, operation);
  // Derived only when the caller named nothing: a predicate that is already there is checked
  // rather than joined by a second one, so a disagreement is refused instead of being answered by
  // whichever of the two the driver applies first.
  const scoped =
    actorOrg !== undefined && !hasOrgPredicate(plan, tenantColumn)
      ? orgScoped(plan, actorOrg, tenantColumn)
      : plan;
  verifyScope(entityName, tenantColumn, operation, scoped, actorOrg);
  return scoped;
};

/**
 * The same guard, verifying a plan that is already built — for a caller holding one this layer did
 * not construct. It cannot derive (there is nowhere to put the predicate), so a plan that names no
 * tenant is `X_TENANCY_UNSCOPED` even where the actor carries one; `scopedPlan` is the path that
 * fills it in.
 */
export const assertScoped = (
  entityName: string,
  tenantColumn: string | null,
  operation: string,
  plan: QueryPlan,
): void => {
  if (tenantColumn === null) return;
  const crossing = crossTenantReason();
  if (crossing !== undefined) {
    assertCrossTenant(crossing);
    return;
  }
  verifyScope(entityName, tenantColumn, operation, plan, actorTenant(entityName, operation));
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
