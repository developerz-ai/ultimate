// Single responsibility: one partitioned table's maintenance, run — create ahead under a bounded
// `lock_timeout`, then retire each expired partition without blocking the parent: mark it, `detach
// … concurrently` (outside any transaction, as Postgres requires), drop it. A `55P03` is
// `X_DB_LOCK_TIMEOUT`, retryable: the caller's retry absorbs a long report query, never the table.

import { finiteCount } from '@ultimat3/core';
import type { DbClient } from './client';
import type { EntityDescriptionLike } from './entity-shape';
import {
  type PartitionMaintenanceOptions,
  partitionMaintenance,
  RETIRING_COMMENT,
} from './generate-partition';
import { identifier, literal, raw } from './sql';
import { withTransaction } from './transaction';
import type { DbTx } from './transaction-options';

/** How long one maintenance statement waits for a lock on the parent before giving up. */
export const PARTITION_LOCK_TIMEOUT_MS = 5000;

export interface PartitionRunOptions extends PartitionMaintenanceOptions {
  readonly lockTimeoutMs?: number | undefined;
}

export interface PartitionRun {
  readonly created: readonly string[];
  readonly dropped: readonly string[];
}

type Expired = { readonly name: string; readonly state: 'attached' | 'pending' | 'detached' };
const RETIREMENT_STATES: readonly string[] = ['attached', 'pending', 'detached'];

const names = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

const expiredOf = (value: unknown): readonly Expired[] =>
  (Array.isArray(value) ? value : []).flatMap((each: unknown): Expired[] => {
    if (typeof each !== 'object' || each === null) return [];
    const { name, state: stage } = each as Record<string, unknown>;
    return typeof name === 'string' &&
      typeof stage === 'string' &&
      RETIREMENT_STATES.includes(stage)
      ? [{ name, state: stage as Expired['state'] }]
      : [];
  });

/** One transaction whose every lock wait is bounded: a blocked DDL fails fast, the table keeps serving. */
const bounded = <T>(client: DbClient, ms: number, work: (tx: DbTx) => Promise<T>): Promise<T> =>
  withTransaction(
    async (tx) => {
      await tx.execute(raw(`set local lock_timeout = ${ms}`));
      return work(tx);
    },
    { client },
  );

/**
 * Creates what `partitionBy` (and `from`) need, then retires each expired partition, resuming a
 * run that died anywhere in between: a `pending` detach is finalized, a `detached` one is dropped.
 * Never inside a caller's transaction — `detach … concurrently` refuses one (`25001`).
 */
export async function maintainPartitions(
  client: DbClient,
  entity: EntityDescriptionLike,
  instant: Date,
  options: PartitionRunOptions = {},
): Promise<PartitionRun> {
  const statement = partitionMaintenance(entity, instant, options);
  if (statement === null) return { created: [], dropped: [] };
  const ms = finiteCount(
    'maintainPartitions',
    'lockTimeoutMs',
    options.lockTimeoutMs ?? PARTITION_LOCK_TIMEOUT_MS,
    1,
  );
  const [row] = await bounded(client, ms, (tx) => tx.query<{ result: unknown }>(statement));
  const result =
    typeof row?.result === 'object' && row.result !== null
      ? (row.result as Record<string, unknown>)
      : {};
  const parent = identifier(entity.table).text;
  const dropped: string[] = [];
  for (const { name, state } of expiredOf(result['expired'])) {
    const child = identifier(name).text;
    if (state === 'attached') {
      await bounded(client, ms, (tx) =>
        tx.execute(raw(`comment on table ${child} is ${literal(RETIRING_COMMENT).text}`)),
      );
      await client.execute(raw(`alter table ${parent} detach partition ${child} concurrently`));
    } else if (state === 'pending') {
      await client.execute(raw(`alter table ${parent} detach partition ${child} finalize`));
    }
    await bounded(client, ms, (tx) => tx.execute(raw(`drop table if exists ${child}`)));
    dropped.push(name);
  }
  return { created: names(result['created']), dropped };
}
