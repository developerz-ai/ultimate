// The aggregate reads compiled to SQL: a grouped count, one aggregate over one column, the
// distinct currencies a money column holds, and the planner's row estimate. Split from `pg-sql.ts`,
// which compiles the row reads they share their predicates with — `conditions()` is imported, never
// restated, so an aggregate counts exactly the rows the matching read would return.

import { identifier, type SqlFragment, sql } from '@ultimat3/db';
import type { AggregateFn } from './aggregate';
import { AVG_SCALE } from './aggregate';
import { kindOf } from './cursor';
import type { EntityCore } from './entity';
import { columnRef, conditions, type ReadShape } from './pg-sql';
import type { QueryPlan } from './tenancy';

/** What a grouped count comes back as. Both names are fixed, so neither can be a column's. */
export interface GroupRow {
  readonly group_value: unknown;
  readonly group_count: unknown;
}

/**
 * The grouped count: one row per distinct value of one column, over exactly the rows
 * `countStatement` would have counted — the same predicates, the same soft-delete filter, one
 * `group by` more. `limit` bounds the groups, not the rows, which is what turns a whole-table
 * breakdown into a refusal instead of a result set nobody sized.
 *
 * Both output names are aliases and fixed, so they cannot collide with each other whatever the
 * table declares: an entity is free to have a column called `count`, and the un-aliased form would
 * then return two outputs of one name.
 */
export const countByStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  column: string,
  limit: number,
): SqlFragment => {
  const grouped = columnRef(entity, column);
  return sql`select ${grouped} as group_value, count(*) as group_count from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)} group by ${grouped} limit ${limit}`;
};

/**
 * One aggregate over exactly the rows `countStatement` would have counted — the same predicates,
 * the same soft-delete filter, one function more. Four outputs and always the same four names, so
 * neither driver reads a column an entity could also have declared:
 *
 * - `agg_value` — the aggregate itself, as TEXT. `::text` and never a float: `sum(bigint)` is a
 *   `numeric` Bun would hand back as a string anyway, and pinning it makes `integer` behave the
 *   same. `aggregate.ts` re-parses it by the column's kind.
 * - `agg_count` — how many non-null values went in, which is what tells `null` ("no rows") from a
 *   legitimate zero, and what `avg` divides by.
 *
 * `avg` is `round(avg(...), AVG_SCALE)` rather than the server's own scale, because the in-memory
 * driver has to reach the same digits and "whatever numeric division gives you" is not a rule two
 * implementations can share.
 */
export const aggregateStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  fn: AggregateFn,
  column: string,
): SqlFragment => {
  const target = columnRef(entity, column);
  const extreme = fn === 'min' ? sql`min(${target})` : sql`max(${target})`;
  const value =
    fn === 'sum'
      ? sql`sum(${target})`
      : fn === 'avg'
        ? sql`round(avg(${target}), ${AVG_SCALE})`
        : // An instant crosses as EPOCH MILLISECONDS, never as the session's own text: `::text`
          // prints in the session's zone, and `new Date` on that answered NaN for an offset with
          // seconds (a pre-1937 LMT) and 1999 for year 0099. Not `at time zone 'UTC'` either —
          // that is an offsetless `timestamp`, which JS reads as LOCAL time.
          kindOf(entity, column) === 'timestamptz'
          ? sql`(extract(epoch from ${extreme}) * 1000)`
          : extreme;
  return sql`select ${value}::text as agg_value, count(${target}) as agg_count from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)}`;
};

/** What an aggregate comes back as. Both names are fixed, so neither can be a column's. */
export interface AggregateRow {
  readonly agg_value: unknown;
  readonly agg_count: unknown;
}

/**
 * The distinct currencies among the rows an aggregate is about to cover. A separate statement
 * rather than a clever one: `sum(minor)` over two currencies is a number in neither, and the only
 * honest answer is to refuse — which needs the list, not a boolean.
 *
 * Bounded at three, because the refusal names them and a caller with three already knows.
 */
export const currenciesStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  currencyColumn: string,
  scaleColumn: string | null,
): SqlFragment => {
  const currency = identifier(currencyColumn);
  // The SCALE is half of what makes two amounts incomparable and it is the half with no symptom:
  // `{ minor: 5, currency: 'USD' }` is five cents and the same row at `scale: 6` is five millionths
  // of a dollar. A table with no scale column has one unit per currency by construction.
  const scale = scaleColumn === null ? sql`null` : identifier(scaleColumn);
  return sql`select distinct ${currency} as group_value, ${scale} as group_scale from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)} and ${currency} is not null limit 3`;
};

/** One `(currency, scale)` pair the rows an aggregate covers actually use. */
export interface MoneyUnitRow {
  readonly group_value: unknown;
  readonly group_scale: unknown;
}

/**
 * The planner's own row estimate for a table — `reltuples`, which is what `ANALYZE` last wrote and
 * what every query plan in the database is already costed against. `count(*)` walks every visible
 * row (MVCC gives no shortcut), so on a large table it is the read that exceeds a web role's
 * `statement_timeout`, and no index can make it cheaper: the `fix:` on that timeout tells an author
 * to add one, and following it changes nothing.
 *
 * `to_regclass` rather than a name comparison, so a search_path change cannot silently answer for a
 * different schema's table of the same name — and `-1` is what Postgres 14+ stores for a table that
 * has never been analysed, which is an answer, not an estimate.
 */
export const estimateStatement = (table: string): SqlFragment =>
  sql`select reltuples::bigint as estimate from pg_class where oid = to_regclass(${table})`;
