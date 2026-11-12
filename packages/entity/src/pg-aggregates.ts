// Single responsibility: the Postgres driver's aggregate reads — `countBy`, `aggregate`,
// `approximateCount` and `series` — each one statement (money: two) under the read path's plan.
// Split from `pg-driver.ts` at its line ceiling; the rules are the shared files' (`aggregate.ts`,
// `count-by.ts`, `time-bucket.ts`), so memory and Postgres answer every one of these alike.

import { type DbClient, withStatementAttribution } from '@ultimat3/db';
import { aggregateColumnOf, aggregateMinor, assertOneUnit, type MoneyUnit } from './aggregate';
import { decodeAggregate } from './aggregate-decode';
import { moneyColumns } from './column';
import { countsFrom, groupColumnOf, groupValue, MAX_GROUPS } from './count-by';
import type { EntityCore } from './entity';
import { type CountByOptions, type MeasureReads, screenMeasureFilter } from './measures';
import { postgresMeasures } from './pg-measures';
import type { ReadShape } from './pg-sql';
import {
  type AggregateRow,
  aggregateStatement,
  countByStatement,
  currenciesStatement,
  estimateStatement,
  type GroupRow,
  type MoneyUnitRow,
  type SeriesRow,
  seriesStatement,
} from './pg-sql-aggregate';
import { readPlan } from './plan';
import type { FindManyArgs, Repo } from './repo';
import type { QueryPlan } from './tenancy';
import { type SeriesPlan, seriesFrom, seriesPlanOf } from './time-bucket';
import type { MoneyValue } from './types';

type AggregateReads<Row> = Pick<
  Required<Repo<Row>>,
  'aggregate' | 'approximateCount' | 'countBy' | 'series'
> &
  MeasureReads;

const shapeOf = (args: FindManyArgs): ReadShape => ({
  includeDeleted: args.includeDeleted === true,
});

const unitOf = (row: MoneyUnitRow): MoneyUnit => ({
  currency: String(row.group_value ?? '').trim(),
  scale: row.group_scale === null || row.group_scale === undefined ? null : Number(row.group_scale),
});

export const postgresAggregates = <Row>(
  entity: EntityCore<Row>,
  client: () => DbClient,
): AggregateReads<Row> => {
  const attributed = <T>(op: string, send: () => Promise<T>): Promise<T> =>
    withStatementAttribution(entity.$name, op, send);

  /**
   * Money is judged BEFORE the aggregate is asked for, in its own statement: `sum(minor)` over two
   * currencies is a number in neither, and the refusal has to name them.
   */
  const moneyUnit = async (
    op: string,
    fn: 'sum' | 'avg' | 'min' | 'max',
    column: string,
    money: ReturnType<typeof moneyColumns>,
    plan: QueryPlan,
    shape: ReadShape,
  ): Promise<MoneyUnit | undefined> =>
    assertOneUnit(
      entity,
      fn,
      column,
      (
        await attributed(op, () =>
          client().query<MoneyUnitRow>(
            currenciesStatement(entity, plan, shape, money.currency, money.scale),
          ),
        )
      ).map(unitOf),
    );

  const moneyOf = (column: string, unit: MoneyUnit, text: string): MoneyValue => ({
    minor: aggregateMinor(entity, 'sum', column, text),
    currency: unit.currency,
    ...(unit.scale === null ? {} : { scale: unit.scale }),
  });

  /** One bucket's value: the count, or the sum decoded as `sum()` decodes it. */
  const pointValue = (plan: SeriesPlan, row: SeriesRow, unit: MoneyUnit | undefined): unknown => {
    if (plan.sum === null) return Number(row.bucket_count);
    const text = row.bucket_value;
    if (text === null || text === undefined) return null;
    const kind = plan.sum.column.$meta.kind;
    if (kind !== 'money') return decodeAggregate('sum', kind, String(text));
    return unit === undefined ? null : moneyOf(plan.sum.property, unit, String(text));
  };

  return {
    ...postgresMeasures(entity, client),

    async countBy(column, args = {}, options: CountByOptions = {}) {
      const op = 'countBy';
      const grouped = groupColumnOf(entity, column, op);
      const where = screenMeasureFilter(entity, options.where ?? []);
      const plan = readPlan(entity, args, op);
      // One group past the bound, for the same reason a page reads one row past its limit: the
      // presence of that group is what says the answer was never going to fit, and `countsFrom`
      // refuses it rather than hand back a breakdown missing its tail.
      const rows = await attributed(op, () =>
        client().query<GroupRow>(
          countByStatement(entity, plan, shapeOf(args), column, MAX_GROUPS + 1, where),
        ),
      );
      return countsFrom(
        entity,
        column,
        op,
        rows.map((row) => [groupValue(grouped, row.group_value), Number(row.group_count)] as const),
      );
    },

    async aggregate(fn, column, args = {}) {
      const op = fn;
      const declared = aggregateColumnOf(entity, fn, column);
      const plan = readPlan(entity, args, op);
      const shape = shapeOf(args);
      const money = declared.$meta.kind === 'money' ? moneyColumns(column, declared.$meta) : null;
      const unit = money === null ? undefined : await moneyUnit(op, fn, column, money, plan, shape);
      const row = await attributed(op, () =>
        client().one<AggregateRow>(
          aggregateStatement(entity, plan, shape, fn, money === null ? column : `${column}.minor`),
        ),
      );
      const text = row?.agg_value;
      if (text === null || text === undefined) return null;
      if (money === null) return decodeAggregate(fn, declared.$meta.kind, String(text));
      if (unit === undefined) return null;
      return {
        minor: aggregateMinor(entity, fn, column, String(text)),
        currency: unit.currency,
        ...(unit.scale === null ? {} : { scale: unit.scale }),
      };
    },

    /**
     * `reltuples`, the planner's own estimate — one row out of `pg_class`, constant time. `count(*)`
     * walks every visible row, so past a few million it trips a web role's `statement_timeout`.
     */
    async approximateCount(args = {}) {
      const op = 'approximateCount';
      // Built and therefore GUARDED: tenancy still applies, and a filtered chain is refused here
      // rather than answered with the whole table's estimate.
      readPlan(entity, args, op);
      const row = await attributed(op, () =>
        client().one<{ estimate: unknown }>(estimateStatement(entity.$table)),
      );
      const estimate = Number(row?.estimate ?? -1);
      // `-1` is what Postgres 14+ stores for a table nobody has analysed. That is an absence of an
      // estimate, not an estimate of zero, and answering `0` would read exactly like an empty
      // table to every caller.
      return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
    },

    async series(spec, args = {}) {
      const op = 'series';
      const series = seriesPlanOf(entity, spec);
      const plan = readPlan(entity, args, op);
      const shape = shapeOf(args);
      const sum = series.sum;
      const money =
        sum?.column.$meta.kind === 'money' ? moneyColumns(sum.property, sum.column.$meta) : null;
      const unit =
        money === null || sum === null
          ? undefined
          : await moneyUnit(op, 'sum', sum.property, money, plan, shape);
      const target = sum === null ? null : money === null ? sum.property : `${sum.property}.minor`;
      // One bucket past the bound, as `countBy` reads one group past it: its presence is the
      // refusal, never a chart missing its tail.
      const rows = await attributed(op, () =>
        client().query<SeriesRow>(
          seriesStatement(entity, plan, shape, series, target, MAX_GROUPS + 1),
        ),
      );
      return seriesFrom(
        entity,
        series,
        rows.map((row) => ({
          bucket: new Date(Number(row.bucket_ms)),
          value: pointValue(series, row, unit),
        })),
      );
    },
  };
};
