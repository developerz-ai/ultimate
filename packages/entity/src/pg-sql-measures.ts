// Single responsibility: several measures, each with its own filter, compiled to ONE statement —
// `count(*) filter (where …)` beside `sum(col) filter (where …)` over the chain's rows. Split from
// `pg-sql-aggregate.ts`; the predicates are `pg-sql.ts`'s, imported, never restated.

import { identifier, join, type SqlFragment, sql } from '@ultimat3/db';
import { AVG_SCALE } from './aggregate';
import { moneyColumns } from './column';
import { kindOf } from './cursor';
import type { EntityCore } from './entity';
import type { PlannedMeasure } from './measures';
import { columnRef, conditions, predicatesSql, type ReadShape } from './pg-sql';
import type { Predicate, QueryPlan } from './tenancy';

/** Output names are positional and fixed (`m0`, `u0`, …): a measure's name never reaches SQL. */
export const valueAlias = (index: number): string => `m${index}`;
export const unitAlias = (index: number): string => `u${index}`;

/** ` filter (where …)`, or nothing — an unfiltered aggregate stays the plain call. */
const filterOf = <Row>(
  entity: EntityCore<Row>,
  where: readonly Predicate[],
  extra?: SqlFragment,
): SqlFragment => {
  const parts = [
    ...(where.length === 0 ? [] : [predicatesSql(entity, where)]),
    ...(extra ? [extra] : []),
  ];
  return parts.length === 0 ? sql`` : sql` filter (where ${join(parts, ' and ')})`;
};

/** The aggregate over `path` with `fn`, at the precision `aggregateStatement` answers with. */
const measureSql = <Row>(
  entity: EntityCore<Row>,
  measure: PlannedMeasure,
  path: string | undefined,
): SqlFragment => {
  const filter = filterOf(entity, measure.where);
  if (path === undefined) return sql`count(*)${filter}`;
  const target = columnRef(entity, path);
  switch (measure.fn) {
    case 'count':
      return sql`count(${target})${filter}`;
    case 'sum':
      return sql`sum(${target})${filter}`;
    case 'avg':
      return sql`round(avg(${target})${filter}, ${AVG_SCALE})`;
    default: {
      const extreme =
        measure.fn === 'min' ? sql`min(${target})${filter}` : sql`max(${target})${filter}`;
      // Epoch milliseconds, never the session's text — `aggregateStatement`'s reason, unchanged.
      return kindOf(entity, path) === 'timestamptz'
        ? sql`(extract(epoch from ${extreme}) * 1000)`
        : extreme;
    }
  }
};

/**
 * The distinct `(currency, scale)` units a money measure covers, as `USD/` or `USD/6` joined by
 * commas — folded into the same statement instead of `currenciesStatement`'s second one. A
 * currency is a three-letter code and a scale an integer, so neither separator can occur in one.
 */
const unitsOf = <Row>(entity: EntityCore<Row>, measure: PlannedMeasure, property: string) => {
  const meta = measure.column?.$meta;
  if (meta === undefined) return sql`null`;
  const money = moneyColumns(property, meta);
  const currency = identifier(money.currency);
  const scale =
    money.scale === null ? sql`''` : sql`coalesce(${identifier(money.scale)}::text, '')`;
  return sql`string_agg(distinct ${currency} || '/' || ${scale}, ',')${filterOf(
    entity,
    measure.where,
    sql`${currency} is not null`,
  )}`;
};

const isMoney = (measure: PlannedMeasure): boolean => measure.column?.$meta.kind === 'money';

/**
 * One row: `m<i>` per measure as TEXT (decoded by the column's kind, as `aggregate()` decodes),
 * and `u<i>` beside every money measure that sums or compares — a count of money has no unit.
 */
export const measuresStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  measures: readonly PlannedMeasure[],
): SqlFragment => {
  const outputs = measures.flatMap((measure, index) => {
    const property = measure.property;
    const money = isMoney(measure);
    const path = property === undefined ? undefined : money ? `${property}.minor` : property;
    const value = sql`${measureSql(entity, measure, path)}::text as ${identifier(valueAlias(index))}`;
    if (!money || measure.fn === 'count' || property === undefined) return [value];
    return [value, sql`${unitsOf(entity, measure, property)} as ${identifier(unitAlias(index))}`];
  });
  return sql`select ${join(outputs)} from ${identifier(entity.$table)} where ${conditions(
    entity,
    plan,
    shape,
  )}`;
};
