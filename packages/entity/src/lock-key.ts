// Single responsibility: what `lockKey` locks, in one place for both drivers. The tenant comes from
// the read path's own plan, so an org's key never blocks another org's and an actor with none is
// refused exactly as a read is, by the same guard and the same code.

import { assert } from '@ultimat3/core';
import type { EntityCore } from './entity';
import { readPlan } from './plan';
import type { RepoOptions } from './repo';

/**
 * `<table>:<tenant or ->:<key>`. `-` is an entity with no tenant, or a `crossTenant()` sweep that
 * named none: the sweep then holds its own key and no org's, and naming `orgId` is how it takes one.
 */
export const lockKeyInput = <Row>(
  entity: EntityCore<Row>,
  key: string,
  options: RepoOptions | undefined,
): string => {
  assert(
    key.trim() !== '',
    `${entity.$name}.lockKey() was given a blank key, so every caller would share one lock`,
    `db.${entity.$name}.lockKey('recount:' + id, fn)   # name what the lock protects`,
  );
  const plan = readPlan(entity, { ...options }, 'lockKey');
  const named = plan.where.find((predicate) => predicate.column === entity.$tenantColumn)?.value;
  return `${entity.$table}:${typeof named === 'string' ? named : '-'}:${key}`;
};
