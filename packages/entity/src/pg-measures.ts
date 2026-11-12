// Single responsibility: the Postgres driver's `aggregates(measures)` — one statement for every
// measure, money's unit check included, decoded exactly as the single-column `aggregate()` decodes.
// The rules are `measures.ts`' and `aggregate.ts`'; this is one driver's execution of them.

import { type DbClient, withStatementAttribution } from '@ultimat3/db';
import { aggregateMinor, assertOneUnit, type MoneyUnit } from './aggregate';
import { decodeAggregate } from './aggregate-decode';
import type { EntityCore } from './entity';
import { type MeasureReads, type PlannedMeasure, planMeasures } from './measures';
import { measuresStatement, unitAlias, valueAlias } from './pg-sql-measures';
import { readPlan } from './plan';

/** `USD/6,EUR/` back into units — the encoding `pg-sql-measures.ts` writes. */
const unitsOf = (text: unknown): readonly MoneyUnit[] =>
  typeof text !== 'string' || text.length === 0
    ? []
    : text.split(',').map((one) => {
        const [currency = '', scale = ''] = one.split('/');
        return { currency: currency.trim(), scale: scale === '' ? null : Number(scale) };
      });

const decodeMeasure = <Row>(
  entity: EntityCore<Row>,
  measure: PlannedMeasure,
  value: unknown,
  units: unknown,
): unknown => {
  // `count` is never null: over no rows it is 0, which is what SQL answers and what a tile shows.
  if (measure.fn === 'count') return Number(value ?? 0);
  if (value === null || value === undefined) return null;
  const { fn, column, property = '' } = measure;
  const kind = column?.$meta.kind ?? 'integer';
  if (kind !== 'money') return decodeAggregate(fn, kind, String(value));
  const unit = assertOneUnit(entity, fn, property, unitsOf(units));
  if (unit === undefined) return null;
  return {
    minor: aggregateMinor(entity, fn, property, String(value)),
    currency: unit.currency,
    ...(unit.scale === null ? {} : { scale: unit.scale }),
  };
};

export const postgresMeasures = <Row>(
  entity: EntityCore<Row>,
  client: () => DbClient,
): MeasureReads => ({
  async aggregates(measures, args = {}) {
    const op = 'aggregate';
    const planned = planMeasures(entity, measures);
    const plan = readPlan(entity, args, op);
    const shape = { includeDeleted: args.includeDeleted === true };
    const row = await withStatementAttribution(entity.$name, op, () =>
      client().one<Readonly<Record<string, unknown>>>(
        measuresStatement(entity, plan, shape, planned),
      ),
    );
    return Object.fromEntries(
      planned.map((measure, index) => [
        measure.name,
        decodeMeasure(entity, measure, row?.[valueAlias(index)], row?.[unitAlias(index)]),
      ]),
    );
  },
});
