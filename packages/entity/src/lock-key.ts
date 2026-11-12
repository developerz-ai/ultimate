// Single responsibility: what `lockKey` and `lockKeys` lock, in one place for every driver. The
// tenant comes from the read path's own plan, so an org's key never blocks another org's and an
// actor with none is refused exactly as a read is, by the same guard and the same code.

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

/**
 * How many keys one `lockKeys` call may hold: Postgres sizes its shared lock table at
 * `max_locks_per_transaction` (default 64) per connection, and a transaction past it is
 * `out of shared memory` for every session on the server, not only this one.
 */
export const MAX_LOCK_KEYS = 64;

/**
 * `lockKeys`' inputs: each key exactly as `lockKey` spells it (same table, tenant and hashing
 * input), duplicates dropped, SORTED — so two callers naming overlapping keys in any order take
 * them in one global order, and neither can hold one the other waits on while waiting itself.
 */
export const lockKeysInput = <Row>(
  entity: EntityCore<Row>,
  keys: readonly string[],
  options: RepoOptions | undefined,
): readonly string[] => {
  assert(
    keys.length > 0,
    `${entity.$name}.lockKeys() was given no keys, so it would serialise nothing while reading as a lock`,
    `db.${entity.$name}.lockKeys(['from:' + fromId, 'to:' + toId], fn)   # name every key the work touches`,
  );
  const inputs = [...new Set(keys.map((key) => lockKeyInput(entity, key, options)))].sort();
  assert(
    inputs.length <= MAX_LOCK_KEYS,
    `${entity.$name}.lockKeys() was given ${inputs.length} keys; past ${MAX_LOCK_KEYS} one transaction can exhaust the server's shared lock table`,
    `db.${entity.$name}.lockKey('batch:' + batchId, fn)   # one coarser key for the whole batch`,
  );
  return inputs;
};

/**
 * Every input held, in the order given, for one `fn`: each lock taken inside the previous one's
 * transaction, so the first opens it and the rest join it — the shape a store with only a
 * one-key lock (`defineDriver`'s `lockKey`, the memory driver's queue) builds `lockKeys` from.
 */
export const holdInOrder = <R, T>(
  inputs: readonly string[],
  lockOne: (input: string, outer: T | undefined, body: (tx: T) => Promise<R>) => Promise<R>,
  fn: (tx: T) => Promise<R> | R,
  outer?: T,
): Promise<R> => {
  const [first, ...rest] = inputs;
  assert(
    first !== undefined,
    'holdInOrder() was given no inputs, so it would hold nothing',
    'holdInOrder(lockKeysInput(entity, keys, options), lockOne, fn)   # lockKeysInput refuses an empty list first',
  );
  return lockOne(first, outer, async (tx) =>
    rest.length === 0 ? fn(tx) : holdInOrder(rest, lockOne, fn, tx),
  );
};
