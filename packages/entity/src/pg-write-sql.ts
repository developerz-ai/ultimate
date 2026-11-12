// Single responsibility: compile a WRITE into parameterised SQL — insert, upsert, update, delete.
// Split from `pg-sql.ts` when that file passed the 500-line ceiling: "which rows does this read
// describe" and "what does this write put there" are two jobs, and only the second one needs to
// know what a conflict target or a jsonb cell is.
//
// The same rule holds on both sides of the split and it is the reason either file exists: nothing
// is interpolated. `sql` binds every scalar and every identifier is resolved through the entity,
// so a column name can only ever be one the entity declared. A many-row `values` list, with its
// `default` cells, is `pg-values-list.ts`'s, compiled in one `sql` call.

import { identifier, join, raw, type SqlFragment, sql } from '@ultimat3/db';
import { columnName } from './column';
import type { EntityCore } from './entity';
import { conditions, type ReadShape } from './pg-sql';
import { valuesList } from './pg-values-list';
import { advancingVersionColumn } from './search-index-version';
import type { QueryPlan } from './tenancy';

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
  /**
   * `false` sends no `returning *`: the command tag's count is the whole answer, and nothing
   * stored crosses back to be decoded. Absent is `returning *`, what `insertAll` resolves with.
   */
  readonly returning?: boolean | undefined;
}

/**
 * A searchable entity's version column, physical — the one a write must ADVANCE past the stored
 * value (`search-index-version.ts`), so two writes inside one millisecond are two versions.
 */
const advancingColumn = <Row>(entity: EntityCore<Row>): string | undefined => {
  const property = advancingVersionColumn(entity as EntityCore<unknown>);
  const meta = property === undefined ? undefined : entity.$columns[property]?.$meta;
  return property === undefined || meta === undefined ? undefined : columnName(property, meta);
};

/**
 * `VERSION_STEP_MS` as an interval — a closed literal like `default` above, and the same one
 * millisecond (`search-version-monotonic.test.ts` pins the two together).
 */
export const VERSION_STEP_SQL = raw("interval '1 millisecond'");

/** `greatest(next, stored + 1 ms)`: the version moves forward even when the clock has not. */
const advanced = (column: string, next: SqlFragment, stored: SqlFragment): SqlFragment =>
  sql`${identifier(column)} = greatest(${next}, ${stored} + ${VERSION_STEP_SQL})`;

const conflictSql = <Row>(entity: EntityCore<Row>, conflict: ConflictTarget): SqlFragment => {
  const target = join(conflict.columns.map(identifier));
  const version = advancingColumn(entity);
  return conflict.set.length === 0
    ? sql` on conflict (${target}) do nothing`
    : sql` on conflict (${target}) do update set ${join(
        conflict.set.map((column) =>
          column === version
            ? advanced(
                column,
                sql`excluded.${identifier(column)}`,
                sql`${identifier(entity.$table)}.${identifier(column)}`,
              )
            : sql`${identifier(column)} = excluded.${identifier(column)}`,
        ),
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
  const tuples = valuesList(jsonColumns(entity), shape.columns, rows);
  const conflict = shape.conflict === undefined ? sql`` : conflictSql(entity, shape.conflict);
  return sql`insert into ${identifier(entity.$table)} (${join(
    shape.columns.map(identifier),
  )}) values ${tuples}${conflict}${shape.returning === false ? sql`` : sql` returning *`}`;
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
  const version = advancingColumn(entity);
  return sql`update ${identifier(entity.$table)} set ${join(
    [...values].map(([column, value]) =>
      column === version
        ? advanced(column, cell(json, column, value), identifier(column))
        : sql`${identifier(column)} = ${cell(json, column, value)}`,
    ),
  )} where ${conditions(entity, plan, shape)}${returning ? sql` returning *` : sql``}`;
};

/** Only reached when the entity has no soft-delete column, so there is no filter to apply. */
export const deleteStatement = <Row>(entity: EntityCore<Row>, plan: QueryPlan): SqlFragment =>
  sql`delete from ${identifier(entity.$table)} where ${conditions(entity, plan, {
    includeDeleted: true,
  })}`;
