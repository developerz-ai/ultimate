// Single responsibility: the in-memory driver's `aggregates(measures)` and the filtered `countBy` —
// each measure folded over the rows its own filter keeps, by the same `matchesPredicate` the read
// path filters with and the same `foldAggregate` `aggregate()` answers with.

import { foldAggregate } from './aggregate-fold';
import { countsFrom, groupColumnOf } from './count-by';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import {
  type CountByOptions,
  type MeasureReads,
  type PlannedMeasure,
  planMeasures,
  screenMeasureFilter,
} from './measures';
import { matchesPredicate } from './memory-match';
import type { FindManyArgs } from './repo';
import type { Predicate } from './tenancy';

/** `memoryRepo`'s own read: the plan built and guarded, the visible rows it matches. */
type MemorySelect<Row> = (args: FindManyArgs, operation: string) => { found: Row[] };

const keeps =
  <Row>(entity: EntityCore<Row>, where: readonly Predicate[]) =>
  (row: Row): boolean =>
    where.every((predicate) => matchesPredicate(entity, row, predicate));

const measureOf = <Row>(entity: EntityCore<Row>, measure: PlannedMeasure, rows: readonly Row[]) => {
  const kept = measure.where.length === 0 ? rows : rows.filter(keeps(entity, measure.where));
  const { property, column } = measure;
  if (measure.fn === 'count') {
    if (property === undefined) return kept.length;
    // `count(col)` counts non-null values; `?? null` reads an absent property as the NULL it is.
    return kept.filter((row) => (valueAt(row, property) ?? null) !== null).length;
  }
  return foldAggregate(entity, measure.fn, property ?? '', column?.$meta.kind ?? 'integer', kept);
};

export const memoryMeasures = <Row>(
  entity: EntityCore<Row>,
  select: MemorySelect<Row>,
): MeasureReads => ({
  async aggregates(measures, args = {}) {
    const planned = planMeasures(entity, measures);
    const { found } = select(args, 'aggregate');
    return Object.fromEntries(
      planned.map((measure) => [measure.name, measureOf(entity, measure, found)]),
    );
  },
});

/**
 * `countBy` with a filter: every group the chain matched, counting only the rows `where` keeps — so
 * a group none of them satisfy is present with 0, as `count(*) filter (where …)` answers it. That
 * is what makes it not `andWhere(…).countBy(…)`, which drops the group.
 */
export const memoryCountBy = async <Row>(
  entity: EntityCore<Row>,
  select: MemorySelect<Row>,
  column: string,
  args: FindManyArgs = {},
  options: CountByOptions = {},
): Promise<ReadonlyMap<unknown, number>> => {
  groupColumnOf(entity, column, 'countBy');
  const where = screenMeasureFilter(entity, options.where ?? []);
  const { found } = select(args, 'countBy');
  const counted = keeps(entity, where);
  const groups = new Map<unknown, number>();
  for (const row of found) {
    // `?? null`, so a property this row never carried lands in the group Postgres puts NULL in.
    const value = valueAt(row, column) ?? null;
    groups.set(value, (groups.get(value) ?? 0) + (counted(row) ? 1 : 0));
  }
  return countsFrom(entity, column, 'countBy', [...groups]);
};
