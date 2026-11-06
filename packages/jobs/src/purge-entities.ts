// Single responsibility: an entity's `retain` as a `PurgeTarget` — the batched, cross-tenant delete
// of every row older than its window — and the record of which entities a `purge()` covers, which
// is what `x verify` reads to refuse a retention promise nothing keeps (`X_ENTITY_RETAIN_UNSWEPT`).

import { assert } from '@ultimat3/core';
import {
  CROSS_TENANT_SETTING,
  identifier,
  PURGE_SETTING,
  setLocal,
  sql,
  withTransaction,
} from '@ultimat3/db';
import { type EntityCore, registeredEntities } from '@ultimat3/entity';
import type { PurgeTarget } from './purge';
import { type PurgeBatching, purgeBatching, purgeInBatches } from './purge-batches';

/**
 * The sweep of one `retain` entity. Each batch is its own transaction that names this table in
 * `x.purge` — the one thing a history table's guard lets delete — and opens `x.cross`: retention is
 * every tenant's, and under forced row security an unset tenant would match no row at all.
 */
export function retainTarget(entity: EntityCore, options: PurgeBatching = {}): PurgeTarget {
  const retain = entity.$retain;
  assert(
    retain !== null,
    `retainTarget(${entity.$name}) — the entity declares no retain, so nothing says which rows expire`,
    `add retain: { after: '90d', on: 'createdAt' } to entity('${entity.$name}'), then x db gen "retention"`,
  );
  const bounds = purgeBatching(`retainTarget(${entity.$name})`, options);
  const table = identifier(entity.$table);
  const column = identifier(retain.column);
  return {
    name: entity.$table,
    purgeExpired: (nowMs) => {
      const cutoff = new Date(nowMs - retain.afterMs);
      return purgeInBatches(
        (size) =>
          withTransaction(async (tx) => {
            await setLocal(tx, { [PURGE_SETTING]: entity.$table, [CROSS_TENANT_SETTING]: 'on' });
            const row = await tx.one<{ removed: number | string }>(
              sql`with gone as (delete from ${table} where ctid in (select ctid from ${table} where ${column} < ${cutoff} limit ${size}) returning 1) select count(*) as removed from gone`,
            );
            return Number(row?.removed ?? 0);
          }),
        bounds,
      );
    },
  };
}

/** Every registered entity that declares `retain`, history tables included, by name. */
export function retainedEntities(): readonly EntityCore[] {
  return registeredEntities().flatMap((entry) =>
    entry.core !== undefined && entry.core.$retain !== null ? [entry.core] : [],
  );
}

let coversAll = false;
const covered = new Set<string>();

/** What `purge({ entities })` declares it sweeps: `'declared'`, or the entities it names. */
export type PurgeEntities = 'declared' | readonly EntityCore[];

/** Recorded at `purge()`, read by `x verify`. */
export function recordPurgeCoverage(entities: PurgeEntities | undefined): void {
  if (entities === undefined) return;
  if (entities === 'declared') coversAll = true;
  else for (const entity of entities) covered.add(entity.$name);
}

/** The retain entities no `purge()` covers, sorted. */
export function unsweptEntities(): readonly string[] {
  if (coversAll) return [];
  return retainedEntities()
    .map((entity) => entity.$name)
    .filter((name) => !covered.has(name))
    .sort();
}

/** The targets `entities` resolves to, read at each attempt as the definition's `targets` is. */
export function entityTargets(entities: PurgeEntities | undefined): readonly PurgeTarget[] {
  if (entities === undefined) return [];
  const list = entities === 'declared' ? retainedEntities() : entities;
  return list.map((entity) => retainTarget(entity));
}

/** Test seam: forget what every `purge()` declared. */
export function resetPurgeCoverage(): void {
  coversAll = false;
  covered.clear();
}
