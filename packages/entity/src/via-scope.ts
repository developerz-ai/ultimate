// Single responsibility: tenancy INSIDE a `via` hop. The subselect reads another entity's table, so
// it is planned through that entity's own `scopedPlan` — the acting actor's tenant applied, or the
// plan refused — exactly as a top-level read of it would be. A hop is the one way a read reaches a
// second table, and a second table read without its guard is a cross-tenant read.

import type { EntityCore } from './entity';
import { tenancyUnscoped } from './errors';
import { orMembers, type ViaValue, viaValue } from './predicate-node';
import { viaTarget } from './predicate-screen';
import { getEntity } from './registry';
import { type Predicate, type QueryPlan, scopedPlan } from './tenancy';

/** Every `via` value this file planned. A driver compiles no other: one built by hand is refused. */
const scoped = new WeakSet<ViaValue>();

/** Whether `value` went through `scopeVias` — the drivers' check before they compile a hop. */
export const isScopedVia = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && scoped.has(value as ViaValue);

/**
 * An untenanted target behind a tenanted source must say why it belongs to no tenant (`shared:`),
 * the same declaration a reference into it needs. Otherwise the hop is an unscoped read reached
 * from inside a tenant, and it is refused as one.
 */
const assertReachable = (source: EntityCore, target: EntityCore, operation: string): void => {
  if (source.$tenantColumn === null || target.$tenantColumn !== null) return;
  if (getEntity(target.$name)?.describe().shared !== undefined) return;
  throw tenancyUnscoped(target.$name, `${operation} via ${source.$name}`);
};

const scopeLevel = (
  source: EntityCore,
  where: readonly Predicate[],
  operation: string,
): readonly Predicate[] =>
  where.map((predicate) => {
    if (predicate.op === 'or') {
      return { ...predicate, value: scopeLevel(source, orMembers(predicate), operation) };
    }
    if (predicate.op !== 'via') return predicate;
    const target = viaTarget(source, predicate);
    assertReachable(source, target, operation);
    const hop = viaValue(predicate);
    const inner: QueryPlan = {
      entity: target.$name,
      where: scopeLevel(target, hop.where, operation),
      orderBy: [],
      limit: 1,
    };
    const value: ViaValue = {
      ...hop,
      where: scopedPlan(target.$name, target.$tenantColumn, `${operation} via`, inner).where,
    };
    scoped.add(value);
    return { ...predicate, value };
  });

/**
 * `plan` with every hop scoped to its target's tenant, at every depth. Called by `readPlan` after
 * the source's own scoping, so every read, count, aggregate and filtered write carries it.
 */
export const scopeVias = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  operation: string,
): QueryPlan => {
  if (!plan.where.some(hasNode)) return plan;
  return { ...plan, where: scopeLevel(entity as EntityCore, plan.where, operation) };
};

const hasNode = (predicate: Predicate): boolean => predicate.op === 'or' || predicate.op === 'via';
