// Single responsibility: compile a `QueryPlan` into parameterised SQL. Nothing here builds a
// string from a value — `sql` binds every scalar to `$n` and refuses anything else — and every
// identifier is resolved through the entity, so a column name can only ever be one the entity
// declared. That is the whole reason this file exists instead of a template literal per method.

import { identifier, join, raw, type SqlFragment, sql } from '@ultimat3/db';
import { snake } from './column';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import { allColumns, columnsOf, physicalName } from './pg-row';
import type { Predicate, QueryPlan, SortKey } from './tenancy';

/** Nothing matches. `in ()` is a syntax error in Postgres, so an empty set needs a constant. */
const NEVER = sql`1 = 0`;

export interface ReadShape {
  /** Soft-deleted rows are hidden unless the caller asked for them. */
  readonly includeDeleted: boolean;
  /** The keyset position, already revived to typed values. */
  readonly seek?: readonly unknown[] | undefined;
}

const columnRef = <Row>(entity: EntityCore<Row>, path: string): SqlFragment =>
  identifier(physicalName(entity, path));

const predicateSql = <Row>(entity: EntityCore<Row>, predicate: Predicate): SqlFragment => {
  const column = columnRef(entity, predicate.column);
  const value = predicate.value;
  switch (predicate.op) {
    case 'eq':
      return value === null ? sql`${column} is null` : sql`${column} = ${value}`;
    case 'neq':
      // `is distinct from` so a null on either side compares as a value, not as unknown.
      return sql`${column} is distinct from ${value}`;
    case 'in': {
      const values = Array.isArray(value) ? value : [value];
      return values.length === 0
        ? NEVER
        : sql`${column} in (${join(values.map((each) => sql`${each}`))})`;
    }
    case 'gt':
      return sql`${column} > ${value}`;
    case 'gte':
      return sql`${column} >= ${value}`;
    case 'lt':
      return sql`${column} < ${value}`;
    case 'lte':
      return sql`${column} <= ${value}`;
    case 'like':
      return sql`${column} like ${value}`;
    case 'is-null':
      return sql`${column} is null`;
    case 'is-not-null':
      return sql`${column} is not null`;
  }
};

/**
 * The keyset seek, spelled out rather than as a row comparison: `(a, b) > (x, y)` requires every
 * key to sort the same way, and a listing that is `published_at desc, id asc` does not.
 */
const seekSql = <Row>(
  entity: EntityCore<Row>,
  orderBy: readonly SortKey[],
  seek: readonly unknown[],
): SqlFragment => {
  const terms = orderBy.map((entry, index) => {
    const equal = orderBy
      .slice(0, index)
      .map((earlier, position) => sql`${columnRef(entity, earlier.column)} = ${seek[position]}`);
    const after = raw(entry.direction === 'desc' ? '<' : '>');
    return sql`(${join(
      [...equal, sql`${columnRef(entity, entry.column)} ${after} ${seek[index]}`],
      ' and ',
    )})`;
  });
  return sql`(${join(terms, ' or ')})`;
};

const conditions = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
): SqlFragment => {
  const parts = plan.where.map((predicate) => predicateSql(entity, predicate));
  if (entity.$softDelete && !shape.includeDeleted) {
    parts.push(sql`${identifier(snake(SOFT_DELETE_COLUMN))} is null`);
  }
  if (shape.seek !== undefined) parts.push(seekSql(entity, plan.orderBy, shape.seek));
  return parts.length === 0 ? sql`true` : join(parts, ' and ');
};

const orderSql = <Row>(entity: EntityCore<Row>, orderBy: readonly SortKey[]): SqlFragment =>
  join(
    orderBy.map(
      (entry) =>
        sql`${columnRef(entity, entry.column)} ${raw(entry.direction === 'desc' ? 'desc' : 'asc')}`,
    ),
  );

/**
 * A projection always carries the primary key and the sort keys even when the caller did not
 * ask for them: without those values the page cannot produce the cursor that continues it.
 */
const projection = <Row>(entity: EntityCore<Row>, plan: QueryPlan): SqlFragment => {
  if (plan.select === undefined) return join(allColumns(entity).map(identifier));
  const wanted = new Set([
    ...plan.select,
    ...entity.$primaryKey,
    ...plan.orderBy.map((entry) => entry.column.split('.')[0] ?? entry.column),
  ]);
  const names = [...wanted].flatMap((property) => {
    const column = entity.$columns[property];
    return column === undefined ? [] : columnsOf(property, column);
  });
  return join(names.map(identifier));
};

export const selectStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  limit: number,
): SqlFragment =>
  sql`select ${projection(entity, plan)} from ${identifier(entity.$table)} where ${conditions(
    entity,
    plan,
    shape,
  )} order by ${orderSql(entity, plan.orderBy)} limit ${limit}`;

export const countStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
): SqlFragment =>
  sql`select count(*) as count from ${identifier(entity.$table)} where ${conditions(entity, plan, shape)}`;

export const insertStatement = <Row>(
  entity: EntityCore<Row>,
  values: ReadonlyMap<string, unknown>,
): SqlFragment => {
  const entries = [...values];
  return sql`insert into ${identifier(entity.$table)} (${join(
    entries.map(([column]) => identifier(column)),
  )}) values (${join(entries.map(([, value]) => sql`${value}`))}) returning *`;
};

export const updateStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  values: ReadonlyMap<string, unknown>,
  shape: ReadShape,
): SqlFragment =>
  sql`update ${identifier(entity.$table)} set ${join(
    [...values].map(([column, value]) => sql`${identifier(column)} = ${value}`),
  )} where ${conditions(entity, plan, shape)} returning *`;

/** Only reached when the entity has no soft-delete column, so there is no filter to apply. */
export const deleteStatement = <Row>(entity: EntityCore<Row>, plan: QueryPlan): SqlFragment =>
  sql`delete from ${identifier(entity.$table)} where ${conditions(entity, plan, {
    includeDeleted: true,
  })}`;
