// Single responsibility: the memory driver's half of a `via` hop. Postgres runs the subselect; here
// the hop is resolved, before any row is judged, to an `in` list of the target column's values over
// the target's stored rows that match its (already tenant-scoped) where — its soft delete applied —
// so both drivers answer one question from one plan.

import { valueAt } from './cursor';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { matchesPredicate } from './memory-match';
import type { MemoryTables } from './memory-same-tenant';
import { orMembers, predicateNodeInvalid, viaValue } from './predicate-node';
import { viaTarget } from './predicate-screen';
import type { Predicate, QueryPlan } from './tenancy';
import { isScopedVia } from './via-scope';

/** Every repository's stored rows, by entity name, per driver — what a hop reads its target from. */
const scans = new WeakMap<MemoryTables, Map<string, () => Iterable<unknown>>>();

/** `memoryRepo` registers its rows here beside its `tables` entry. */
export const registerMemoryScan = (
  tables: MemoryTables,
  name: string,
  rows: () => Iterable<unknown>,
): void => {
  let byName = scans.get(tables);
  if (byName === undefined) {
    byName = new Map();
    scans.set(tables, byName);
  }
  byName.set(name, rows);
};

const isDeleted = (target: EntityCore, row: unknown): boolean => {
  if (!target.$softDelete) return false;
  const stamp = valueAt(row, SOFT_DELETE_COLUMN);
  return stamp !== null && stamp !== undefined;
};

const resolveLevel = (
  source: EntityCore,
  where: readonly Predicate[],
  tables: MemoryTables,
): readonly Predicate[] =>
  where.map((predicate): Predicate => {
    if (predicate.op === 'or') {
      return { ...predicate, value: resolveLevel(source, orMembers(predicate), tables) };
    }
    if (predicate.op !== 'via') return predicate;
    if (!isScopedVia(predicate.value)) {
      throw predicateNodeInvalid(
        source.$name,
        'a via hop reached the driver without readPlan scoping it',
      );
    }
    const target = viaTarget(source, predicate);
    const hop = viaValue(predicate);
    const inner = resolveLevel(target, hop.where, tables);
    // A target this driver holds no repository for has no rows — as an empty table answers.
    const rows = scans.get(tables)?.get(target.$name)?.() ?? [];
    const values: unknown[] = [];
    for (const row of rows) {
      if (isDeleted(target, row)) continue;
      if (!inner.every((each) => matchesPredicate(target, row, each))) continue;
      values.push(valueAt(row, hop.target));
    }
    // NULL never matches `in (select …)`; dropped so `in`'s own null rule cannot reintroduce it.
    const present = values.filter((value) => value !== null && value !== undefined);
    return { column: predicate.column, op: 'in', value: present };
  });

/** `plan` with every hop answered from this driver's rows. A plan with no hop comes back as is. */
export const resolveMemoryVias = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  tables: MemoryTables,
): QueryPlan => {
  const nodes = plan.where.some((predicate) => predicate.op === 'or' || predicate.op === 'via');
  return nodes ? { ...plan, where: resolveLevel(entity as EntityCore, plan.where, tables) } : plan;
};
