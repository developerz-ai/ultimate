// Single responsibility: compile a `QueryPlan` into parameterised SQL. Nothing here builds a
// string from a value — `sql` binds every scalar to `$n` and refuses anything else — and every
// identifier is resolved through the entity, so a column name can only ever be one the entity
// declared. That is the whole reason this file exists instead of a template literal per method.

import { identifier, join, raw, type SqlFragment, sql } from '@ultimat3/db';
import { columnName } from './column';
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
 * A cursor's timestamp is the row's own value FLOORED: a `Date` holds milliseconds and a
 * `timestamptz` column holds microseconds, so `created_at > '…123'` is satisfied by the very row
 * at `…123456` the cursor was minted from — the same row, returned again, on every page boundary.
 * Under `desc` the same gap does the opposite and silently drops every row inside that
 * millisecond, which no `id` tiebreak can recover because the first `or` term never matched.
 *
 * So a timestamp seek compares against the millisecond WINDOW its value stands for — what
 * `date_trunc('milliseconds', …)` would say, spelled as a half-open range so the column stays
 * bare and an index can still range-scan it. `timestamptz` is the only sort kind revived as a
 * `Date` (`cursor.ts`), so the type test IS the kind test.
 */
const nextMillisecond = (value: Date): Date => new Date(value.getTime() + 1);

/** Strictly past the cursor's position in this key's direction. */
const seekAfter = (column: SqlFragment, direction: string, value: unknown): SqlFragment => {
  if (direction === 'desc') return sql`${column} < ${value}`;
  // `>= v + 1ms` is `trunc(col) > v`; `< v` already is `trunc(col) < v`, so only asc moves.
  if (value instanceof Date) return sql`${column} >= ${nextMillisecond(value)}`;
  return sql`${column} > ${value}`;
};

/** At the cursor's position for this key — the prefix a later key's tiebreak hangs off. */
const seekEqual = (column: SqlFragment, value: unknown): SqlFragment =>
  value instanceof Date
    ? sql`(${column} >= ${value} and ${column} < ${nextMillisecond(value)})`
    : sql`${column} = ${value}`;

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
      .map((earlier, position) => seekEqual(columnRef(entity, earlier.column), seek[position]));
    return sql`(${join(
      [...equal, seekAfter(columnRef(entity, entry.column), entry.direction, seek[index])],
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
    parts.push(sql`${identifier(physicalName(entity, SOFT_DELETE_COLUMN))} is null`);
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

/** `on conflict (…) do update set …`, or `do nothing` when there is nothing to overwrite. */
export interface ConflictTarget {
  /** Physical columns of the unique index a collision is judged against. */
  readonly columns: readonly string[];
  /** Physical columns a colliding row takes from the incoming one. Empty is `do nothing`. */
  readonly set: readonly string[];
}

export interface InsertShape {
  /** Every physical column written — one list, shared by every row of the statement. */
  readonly columns: readonly string[];
  /** How a collision resolves. Absent, it is the caller's error, exactly as it is for one row. */
  readonly conflict?: ConflictTarget | undefined;
}

/**
 * The cell of a row that did not name this column. `default` is the second and last `raw()` in
 * this file and, like `asc|desc` above it, a closed set of one word: it is what makes a row inside
 * a many-row `insert` mean what the same row means on its own, where an unnamed column is simply
 * left out. The seek operator used to be a third — it is chosen in TypeScript now
 * (`seekAfter`/`seekEqual`), because a timestamp seek is not one operator.
 */
const DEFAULT_CELL = raw('default');

const conflictSql = (conflict: ConflictTarget): SqlFragment => {
  const target = join(conflict.columns.map(identifier));
  return conflict.set.length === 0
    ? sql` on conflict (${target}) do nothing`
    : sql` on conflict (${target}) do update set ${join(
        conflict.set.map((column) => sql`${identifier(column)} = excluded.${identifier(column)}`),
      )}`;
};

/**
 * The one column that cannot be bound as itself. A `jsonb` value is a plain object, and the
 * driver seam refuses one as a parameter (`X_SQL_UNSAFE` — `isBoundValue` takes scalars, a `Date`,
 * a `Uint8Array` and arrays of those); so `bindValues` hands over the JSON TEXT and the cell says
 * what to do with it.
 *
 * `::text::jsonb` and not `::jsonb`, and the double cast is load-bearing rather than defensive.
 * Measured against Postgres 17.10 through Bun's `sql`: with `$1::jsonb` the server describes the
 * parameter as `jsonb`, the client JSON-ENCODES the string it was given, and `{"a":1}` is stored
 * as the JSON *string* `"{\"a\":1}"` — `jsonb_typeof` says `string`. Pinning the parameter to
 * `text` first makes the client send the characters and the server parse them, which is the one
 * spelling that stores an object.
 */
/** Physical names of this entity's `jsonb` columns. Resolved ONCE per statement, never per cell. */
const jsonColumns = <Row>(entity: EntityCore<Row>): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.kind === 'jsonb') names.add(columnName(property, column.$meta));
  }
  return names;
};

/**
 * `${value}`, plus the cast that column needs. The `raw()` argument is a literal written here and
 * nowhere else — the audit point that call is stays a two-word constant, never a value.
 */
const cell = (json: ReadonlySet<string>, column: string, value: unknown): SqlFragment =>
  json.has(column) ? sql`${value}${raw('::text::jsonb')}` : sql`${value}`;

/**
 * One statement for any number of rows. A single row compiles to exactly the text it always did,
 * which is the point: `insertAll([row])` and `insert(row)` are one code path, so there is no
 * second insert builder for the two to drift apart in.
 */
export const insertStatement = <Row>(
  entity: EntityCore<Row>,
  rows: readonly ReadonlyMap<string, unknown>[],
  shape: InsertShape,
): SqlFragment => {
  const json = jsonColumns(entity);
  const tuples = rows.map(
    (row) =>
      sql`(${join(
        shape.columns.map((column) =>
          row.has(column) ? cell(json, column, row.get(column)) : DEFAULT_CELL,
        ),
      )})`,
  );
  const conflict = shape.conflict === undefined ? sql`` : conflictSql(shape.conflict);
  return sql`insert into ${identifier(entity.$table)} (${join(
    shape.columns.map(identifier),
  )}) values ${join(tuples)}${conflict} returning *`;
};

/**
 * `returning` is a parameter and has no default, because the three callers want three different
 * answers and the wrong one is not visible in the result: `update(id, patch)` needs the stored row,
 * a soft delete and a filtered write need a count, and `returning *` on a filtered write over a
 * whole tenant streams every matched row into the process for nobody to read. A default would make
 * that the quiet case.
 */
export const updateStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  values: ReadonlyMap<string, unknown>,
  shape: ReadShape,
  returning: boolean,
): SqlFragment => {
  const json = jsonColumns(entity);
  return sql`update ${identifier(entity.$table)} set ${join(
    [...values].map(([column, value]) => sql`${identifier(column)} = ${cell(json, column, value)}`),
  )} where ${conditions(entity, plan, shape)}${returning ? sql` returning *` : sql``}`;
};

/** Only reached when the entity has no soft-delete column, so there is no filter to apply. */
export const deleteStatement = <Row>(entity: EntityCore<Row>, plan: QueryPlan): SqlFragment =>
  sql`delete from ${identifier(entity.$table)} where ${conditions(entity, plan, {
    includeDeleted: true,
  })}`;
