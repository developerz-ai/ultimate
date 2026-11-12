// Single responsibility: a `defineDriver` write of a versioned entity, one store call per row since
// `v = stored + 1` is per row. `update(id)`/`updateMany` name the version and compare-and-set on
// it; a filtered write names none and, like Postgres's `set v = v + 1`, never answers stale.

import { valueAt } from './cursor';
import type { DriverAdvance } from './driver-kit-types';
import type { DriverScope } from './driver-scope';
import { mergedRow } from './memory-update';
import { namedColumns } from './plan';
import type { Tx } from './repo';
import { rowKey } from './row-key';
import { assertRowTenant, type QueryPlan } from './tenancy';
import { entityStale } from './version-lock-errors';

/**
 * How many times a filtered write re-reads one row a concurrent writer keeps moving. Each miss is
 * another writer's progress; the bound only stops a store whose conditioned update never matches.
 */
export const MAX_VERSION_RETRIES = 16;

export interface VersionedWrite<Row> {
  readonly op: string;
  readonly plan: QueryPlan;
  readonly patch: object;
  /** The version property (`versionOf(entity)`). */
  readonly lock: string;
  /** The rows the plan matched, as read, each with the row the patch made of it. */
  readonly found: readonly Row[];
  readonly results: readonly Row[];
  readonly advance: DriverAdvance | undefined;
  readonly narrowed: Readonly<Record<string, unknown>>;
  readonly tx: Tx | undefined;
  /** Same-tenant references of a re-merged row, judged as the batch was. */
  readonly references: (rows: readonly Row[]) => Promise<void>;
}

/**
 * Writes every row conditioned on the version it was READ at. A miss is `X_ENTITY_STALE` when the
 * patch named the version; otherwise the row is re-read under the same plan — gone or out of the
 * filter is skipped, as Postgres re-checks the WHERE on the newer row — re-merged, re-judged and
 * written again at ITS version, so neither increment is lost. Answers how many rows were written.
 */
export const versionedWrites = async <Row>(
  scope: DriverScope<Row>,
  write: VersionedWrite<Row>,
): Promise<number> => {
  const { entity, raw } = scope;
  const { op, plan, patch, lock, advance, narrowed, tx } = write;
  const checks = namedColumns(patch).some(([key]) => key === lock);
  const keyed = (row: Row, withVersion: boolean): QueryPlan => ({
    ...plan,
    where: [
      ...plan.where,
      ...entity.$primaryKey.map((key) => ({
        column: key,
        op: 'eq' as const,
        value: valueAt(row, key),
      })),
      ...(withVersion ? [{ column: lock, op: 'eq' as const, value: valueAt(row, lock) }] : []),
    ],
  });
  // The narrowed values the merge produced, so the store holds what was judged; the version is
  // one past the read row's, and a searchable version the patch's instant the store advances.
  const valuesOf = (result: Row): Record<string, unknown> => {
    const merged = result as Readonly<Record<string, unknown>>;
    const values = Object.fromEntries(namedColumns(patch).map(([key]) => [key, merged[key]]));
    values[lock] = merged[lock];
    if (advance !== undefined) values[advance.property] = narrowed[advance.property];
    return values;
  };
  const stale = (row: Row) =>
    entityStale(entity.$name, lock, rowKey(entity, row), valueAt(row, lock), undefined);
  let written = 0;
  for (const [at, first] of write.found.entries()) {
    let read = first;
    let result = write.results[at] as Row;
    for (let attempt = 0; ; attempt += 1) {
      const count = await raw.update({ plan: keyed(read, true), tx }, valuesOf(result), advance);
      if (count > 0) {
        written += count;
        break;
      }
      if (checks || attempt >= MAX_VERSION_RETRIES) throw stale(read);
      const again = keyed(read, false);
      const [fresh] = scope.checked(
        op,
        again,
        await raw.select({ plan: again, after: undefined, limit: 1, tx }),
      );
      if (fresh === undefined) break;
      read = fresh;
      result = mergedRow(entity, fresh, patch);
      assertRowTenant(entity.$name, entity.$tenantColumn, op, result);
      entity.$assert(result);
      await write.references([result]);
    }
  }
  return written;
};
