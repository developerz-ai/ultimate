// Single responsibility: the in-memory driver's aggregate reads — `aggregate`, `approximateCount`,
// `countBy` and `series` — over rows the driver already selected. Split from `memory-repo.ts` at
// its line ceiling; every rule here is read from the file both drivers share (`aggregate.ts`,
// `count-by.ts`, `time-bucket.ts`), so this is execution, never a second meaning.

import { aggregateColumnOf, assertOneUnit, type MoneyUnit } from './aggregate';
import { foldAggregate } from './aggregate-fold';
import { countsFrom, groupColumnOf } from './count-by';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import type { FindManyArgs, Repo } from './repo';
import type { QueryPlan } from './tenancy';
import { bucketStart, type SeriesPoint, seriesFrom, seriesPlanOf } from './time-bucket';

/** `memoryRepo`'s own read: the plan built and guarded, the visible rows it matches. */
export type MemorySelect<Row> = (
  args: FindManyArgs,
  operation: string,
) => { plan: QueryPlan; found: Row[] };

type AggregateReads<Row> = Pick<
  Required<Repo<Row>>,
  'aggregate' | 'approximateCount' | 'countBy' | 'series'
>;

const moneyUnitOf = (value: unknown): MoneyUnit | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const money = value as { readonly currency?: unknown; readonly scale?: unknown };
  if (typeof money.currency !== 'string') return undefined;
  return { currency: money.currency, scale: typeof money.scale === 'number' ? money.scale : null };
};

export const memoryAggregates = <Row>(
  entity: EntityCore<Row>,
  select: MemorySelect<Row>,
): AggregateReads<Row> => ({
  async aggregate(fn, column, args = {}) {
    // Refused before a row is read, and by the same function the Postgres driver calls: a column
    // that has no aggregate is that mistake in both drivers or in neither.
    const declared = aggregateColumnOf(entity, fn, column);
    const { found } = select(args, fn);
    return foldAggregate(entity, fn, column, declared.$meta.kind, found);
  },

  /**
   * Exact here, and that is the honest answer rather than a shortcut: the estimate exists
   * because `count(*)` walks every visible row of a real table, and this driver's rows are
   * already an array whose length is free. Filters are refused in both drivers by `plan.ts`,
   * so the two still answer the same QUESTION.
   */
  async approximateCount(args = {}) {
    return select(args, 'approximateCount').found.length;
  },

  async countBy(column, args = {}) {
    // Refused before a row is read, and by the same function the Postgres driver calls: a column
    // a map cannot be keyed by is that mistake in both drivers or in neither.
    groupColumnOf(entity, column, 'countBy');
    const { found } = select(args, 'countBy');
    const groups = new Map<unknown, number>();
    for (const row of found) {
      // `?? null`, so a property this row never carried lands in the same group Postgres puts a
      // NULL row in — and `0`, `''` and `false` stay the values they are.
      const value = valueAt(row, column) ?? null;
      groups.set(value, (groups.get(value) ?? 0) + 1);
    }
    return countsFrom(entity, column, 'countBy', [...groups]);
  },

  async series(spec, args = {}) {
    const plan = seriesPlanOf(entity, spec);
    const { found } = select(args, 'series');
    const sum = plan.sum;
    // One unit across EVERY matched row, before any bucket: the Postgres driver judges the whole
    // predicate in one statement, so a bucket-by-bucket check here would answer where it refuses.
    if (sum?.column.$meta.kind === 'money') {
      const units = found.flatMap((row) => moneyUnitOf(valueAt(row, sum.property)) ?? []);
      assertOneUnit(entity, 'sum', sum.property, units);
    }
    // A row with no instant is in no bucket — Postgres' statement says `is not null`.
    const buckets = new Map<number, Row[]>();
    for (const row of found) {
      const at = valueAt(row, plan.on);
      if (!(at instanceof Date)) continue;
      const start = bucketStart(at, plan.unit, plan.timeZone).getTime();
      const bucket = buckets.get(start);
      if (bucket === undefined) buckets.set(start, [row]);
      else bucket.push(row);
    }
    const points: SeriesPoint[] = [...buckets].map(([start, rows]) => ({
      bucket: new Date(start),
      value:
        sum === null
          ? rows.length
          : foldAggregate(entity, 'sum', sum.property, sum.column.$meta.kind, rows),
    }));
    return seriesFrom(entity, plan, points);
  },
});
