// Single responsibility: the contract a custom store implements under `defineDriver` — the raw
// repository. It receives plans the kit has already scoped (tenant, soft delete, page bound, total
// order, cursor position), never `FindManyArgs`, so there is no argument a driver could read and
// skip a guard by. Every guard stays the kit's; the store only stores.

import type { AggregateFn } from './aggregate';
import type { UpsertPlan } from './bulk-write';
import type { EntityCore } from './entity';
import type { Transactor, Tx } from './repo';
import type { QueryPlan } from './tenancy';
import type { SeriesPoint, SeriesSpec } from './time-bucket';

/**
 * What a store may declare beyond the required five methods. A call needing an undeclared one is
 * `X_DRIVER_UNSUPPORTED` with the capability in `meta.capability`; a declared one with no method
 * behind it is `X_DRIVER_CAPABILITY_MISSING` at definition.
 */
export const DRIVER_CAPABILITIES = [
  'transactions',
  'lock',
  'series',
  'upsert',
  'matches',
  'aggregate:countBy',
  'aggregate:sum',
  'aggregate:avg',
  'aggregate:min',
  'aggregate:max',
  'aggregate:approximateCount',
] as const;

export type DriverCapability = (typeof DRIVER_CAPABILITIES)[number];

/** The rows a filtered call addresses. `plan.where` already carries the tenant and soft delete. */
export interface DriverFilter {
  readonly plan: QueryPlan;
  readonly tx?: Tx | undefined;
}

/**
 * One page: the rows matching EVERY `plan.where` predicate, ordered by `plan.orderBy`, strictly
 * after `after` (the cursor's sort values, aligned with `plan.orderBy`) when present, at most
 * `limit`. Whole rows — the kit projects `select` itself, after it has checked the scope.
 */
export interface DriverRead extends DriverFilter {
  readonly after: readonly unknown[] | undefined;
  readonly limit: number;
}

export interface DriverWrite {
  readonly tx?: Tx | undefined;
}

/**
 * Rows arrive narrowed, tenant-checked and invariant-judged; a duplicate key is the store's to
 * refuse, with `entityUniqueViolation(entity, constraint)`. Writes are all or nothing per call.
 */
export interface DriverRepo<Row> {
  select(read: DriverRead): Promise<readonly Row[]>;
  count(filter: DriverFilter): Promise<number>;
  /** The rows as stored, defaults included, in the order given. */
  insert(rows: readonly Row[], write: DriverWrite): Promise<readonly Row[]>;
  /** Sets `patch` (property names, already parsed) on every matched row; answers how many. */
  update(filter: DriverFilter, patch: Readonly<Record<string, unknown>>): Promise<number>;
  delete(filter: DriverFilter): Promise<number>;
  /** `'upsert'`. The plan is `bulk-write.ts`'s — target, overwritten columns — already judged. */
  upsert?(rows: readonly Row[], plan: UpsertPlan, write: DriverWrite): Promise<readonly Row[]>;
  /** `'aggregate:countBy'`. Pairs of value and count; the kit orders and bounds them. */
  countBy?(column: string, filter: DriverFilter): Promise<readonly (readonly [unknown, number])[]>;
  /** `'aggregate:<fn>'`. Decimal text or a money value, never a float; `null` for no rows. */
  aggregate?(fn: AggregateFn, column: string, filter: DriverFilter): Promise<unknown>;
  /** `'aggregate:approximateCount'`. The whole table's estimate; `null` when unknown. */
  approximateCount?(): Promise<number | null>;
  /** `'series'`. `time-bucket.ts` is the meaning: buckets truncated in `spec.timeZone`. */
  series?(spec: SeriesSpec, filter: DriverFilter): Promise<readonly SeriesPoint[]>;
  /** `'lock'`. Holds the one row `filter` addresses for as long as `fn` runs. */
  lock?<R>(filter: DriverFilter, fn: (row: Row | null, tx: Tx) => Promise<R> | R): Promise<R>;
  /** `'lock'`. `fn` alone among callers of `key` (already tenant-qualified by the kit). */
  lockKey?<R>(key: string, fn: (tx: Tx) => Promise<R> | R, tx: Tx | undefined): Promise<R>;
}

export interface DriverDefinition {
  /** Named in every refusal, so an operator knows which store answered. */
  readonly name: string;
  readonly capabilities: readonly DriverCapability[];
  repo<Row>(entity: EntityCore<Row>): DriverRepo<Row>;
  /** Required by `'transactions'`; without it the driver's `transactor()` refuses. */
  transactor?(): Transactor;
  /** The test seam `Driver.reset?()` forwards to. */
  reset?(): void;
}
