// Single responsibility: `entity({ partitionBy })` checked where it is written. Postgres' rules
// become declaration errors here — the key and every unique index hold the partition column, the
// column is a timestamp or a date — so `x db gen` never writes a migration the server refuses.
// The SQL (the `partition by` clause, creating ahead, retention) is `@ultimat3/db`'s.

import { renderFixShellArg } from '@ultimat3/core';
import { PARTITION_INTERVALS, type PartitionInterval } from '@ultimat3/db';
import { parseDuration } from '@ultimat3/time';
import { columnName } from './column';
import { EntityError } from './errors';
import type { AnyColumn, IndexDef } from './types';

const INTERVALS: readonly string[] = PARTITION_INTERVALS;
const KINDS: readonly string[] = ['timestamptz', 'date'];

/** Partitions kept ready past the current one, when `ahead` is not said. */
export const DEFAULT_PARTITIONS_AHEAD = 3;
/** Postgres' NAMEDATALEN - 1, less the `_pYYYYMMDD` every partition name adds. */
const MAX_PARENT_BYTES = 63 - 10;

/** What `partitionBy` declares. A range by `column`, one partition per `interval`, UTC bounds. */
export interface PartitionInit<K extends string = string> {
  readonly column: K;
  readonly interval: PartitionInterval;
  /** Partitions created past the current one, by the migration and by every maintenance run. */
  readonly ahead?: number;
  /** Whole partitions whose upper bound is older than `after` are detached, then dropped. */
  readonly retain?: { readonly after: string };
}

/** The checked declaration, physical column. Structurally `@ultimat3/db`'s `PartitionDescriptionLike`. */
export interface PartitionDescription {
  readonly column: string;
  readonly interval: PartitionInterval;
  readonly ahead: number;
  readonly retain?: { readonly after: string; readonly afterMs: number } | undefined;
}

/** The rest of the declaration a partitioning has to agree with. */
export interface PartitionContext {
  readonly table: string;
  readonly columns: readonly (readonly [string, AnyColumn])[];
  /** Properties, as `primaryKey` names them. */
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexDef[];
  /** Unique invariants' physical columns. */
  readonly uniques: readonly (readonly string[])[];
  readonly retain: boolean;
  readonly view: boolean;
}

export const partitionInvalid = (entity: string, reason: string, edit: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_PARTITION_INVALID',
    cause: `entity "${entity}" declares partitionBy, and ${reason}`,
    fix: `x db gen "partition"   # after ${edit} in entity('${renderFixShellArg(entity, '<entity>')}')`,
  });

const retainOf = (entity: string, after: unknown): PartitionDescription['retain'] => {
  let afterMs = Number.NaN;
  try {
    afterMs = typeof after === 'string' ? parseDuration(after) : Number.NaN;
  } catch {
    // Reported below with the edit, the one place a bad window is described.
  }
  if (!(afterMs > 0)) {
    throw partitionInvalid(
      entity,
      'partitionBy.retain.after is no window longer than zero',
      "partitionBy.retain: { after: '400d' }",
    );
  }
  return { after: String(after), afterMs };
};

/** `null` when `partitionBy` is absent. Every refusal raised here is at declaration. */
export function partitionOf(
  entity: string,
  init: PartitionInit | undefined,
  context: PartitionContext,
): PartitionDescription | null {
  if (init === undefined) return null;
  const refuse = (reason: string, edit: string): never => {
    throw partitionInvalid(entity, reason, edit);
  };
  if (context.view) refuse('is a view: a view has no partitions', 'removing partitionBy');
  if (context.retain) {
    refuse(
      'retain sits beside it: a partitioned table drops whole partitions, never rows',
      'moving the window to partitionBy.retain: { after }',
    );
  }
  if (!INTERVALS.includes(init.interval)) {
    refuse(
      `interval "${String(init.interval)}" is none of ${INTERVALS.join(', ')}`,
      "interval: 'month'",
    );
  }
  const ahead = init.ahead ?? DEFAULT_PARTITIONS_AHEAD;
  if (!Number.isInteger(ahead) || ahead < 0 || ahead > 1000) {
    refuse('partitionBy.ahead is no whole number from 0 to 1000', 'ahead: 3');
  }
  if (new TextEncoder().encode(context.table).length > MAX_PARENT_BYTES) {
    refuse(
      `its table name is over ${MAX_PARENT_BYTES} bytes, and each partition adds 10 (_pYYYYMMDD)`,
      "table: '<a shorter name>'",
    );
  }
  const column = context.columns.find(([property]) => property === init.column)?.[1];
  if (column === undefined || !KINDS.includes(column.$meta.kind)) {
    throw partitionInvalid(
      entity,
      `partitionBy.column "${String(init.column)}" is no timestamp() or date() column of it`,
      "column: 'at'",
    );
  }
  if (!context.primaryKey.includes(init.column)) {
    refuse(
      `its primary key (${context.primaryKey.join(', ')}) does not hold "${init.column}": Postgres requires it`,
      `primaryKey: [${[...context.primaryKey, init.column].map((key) => `'${key}'`).join(', ')}]`,
    );
  }
  const physical = columnName(init.column, column.$meta);
  const unique = [
    ...context.indexes.filter((index) => index.unique).map((index) => index.columns),
    ...context.uniques,
  ].find((columns) => !columns.includes(physical));
  if (unique !== undefined) {
    refuse(
      `a unique index on (${unique.join(', ')}) does not hold "${physical}": Postgres requires it`,
      `adding ${init.column} to that unique index or invariant`,
    );
  }
  return {
    column: physical,
    interval: init.interval,
    ahead,
    ...(init.retain === undefined ? {} : { retain: retainOf(entity, init.retain.after) }),
  };
}
