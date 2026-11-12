// Single responsibility: compile an `updateMany` batch into `update … from (…) as v` statements —
// a different value per row, one statement per bind-count chunk. Nothing is interpolated: every
// cell is bound and every identifier is the entity's or one of the closed aliases written here.
//
// Measured (Postgres 17, Bun's `sql`): a bound `values ($1, $2), …` list resolves its columns as
// `text`, so `uuid = text` refuses the join. A `select <columns> from <table> where false` head,
// `union all`-ed with one `select $…` per row, types every column from the TABLE instead: a leaf's
// unknown parameters take the union's common type. No type name is spelled here, so none can drift.

import { identifier, join, type SqlFragment, sql } from '@ultimat3/db';
import { MAX_BIND_PARAMETERS } from './bulk-write';
import { columnName } from './column';
import type { EntityCore } from './entity';
import { bindValues, physicalName } from './pg-row';
import { conditions } from './pg-sql';
import { VERSION_STEP_SQL } from './pg-write-sql';
import { advancingVersionColumn } from './search-index-version';
import type { UpdateManyPlan } from './update-many';

/**
 * The source's column names. Upper case, which no physical column can be (`seekAlias` relies on
 * the same rule), so the scope's unqualified `"org_id" = $n` can never be ambiguous with them.
 */
const KEY_ALIAS = 'K$UM';
const aliasOf = (position: number): string => `C${position}$UM`;
const SOURCE = identifier('v');

/** Physical `jsonb` columns, resolved once per batch. */
const jsonColumns = <Row>(entity: EntityCore<Row>): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.kind === 'jsonb') names.add(columnName(property, column.$meta));
  }
  return names;
};

/** A searchable entity's version column, physical: advanced past the stored one, never set back. */
const versionColumn = <Row>(entity: EntityCore<Row>): string | undefined => {
  const property = advancingVersionColumn(entity as EntityCore<unknown>);
  return property === undefined ? undefined : physicalName(entity, property);
};

/** Rows per statement: what the bind budget left after the scope's own binds, over one row's width. */
const chunked = <T>(items: readonly T[], width: number, reserved: number): readonly T[][] => {
  const size = Math.max(1, Math.floor((MAX_BIND_PARAMETERS - reserved) / width));
  const chunks: T[][] = [];
  for (let from = 0; from < items.length; from += size) chunks.push(items.slice(from, from + size));
  return chunks;
};

/**
 * One statement per chunk. `returning` is `"<table>".*`, never `*`: a bare star would add the
 * source's columns to every row handed back. Without it the answer is a count.
 */
export const updateManyStatements = <Row>(
  entity: EntityCore<Row>,
  plan: UpdateManyPlan<Row>,
  returning: boolean,
): readonly SqlFragment[] => {
  if (plan.patches.length === 0) return [];
  const table = identifier(entity.$table);
  const keyColumn = physicalName(entity, plan.key);
  const bound = plan.patches.map(({ id, patch }) => ({
    key: bindValues(entity, { [plan.key]: id } as typeof patch).get(keyColumn),
    values: bindValues(entity, patch),
  }));
  // Every patch names the same properties (`updateManyPlan`), so the first row's physical columns
  // are every row's — money's two or three included.
  const columns = [...(bound[0]?.values.keys() ?? [])];
  const json = jsonColumns(entity);
  const version = versionColumn(entity);
  const where = conditions(entity, plan.scope, { includeDeleted: false });
  const head = sql`select ${join([
    sql`${identifier(keyColumn)} as ${identifier(KEY_ALIAS)}`,
    ...columns.map((column, at) => sql`${identifier(column)} as ${identifier(aliasOf(at))}`),
  ])} from ${table} where false`;
  const set = join(
    columns.map((column, at) => {
      const next = sql`${SOURCE}.${identifier(aliasOf(at))}`;
      return column === version
        ? sql`${identifier(column)} = greatest(${next}, ${table}.${identifier(column)} + ${VERSION_STEP_SQL})`
        : sql`${identifier(column)} = ${next}`;
    }),
  );
  const tail = returning ? sql` returning ${table}.*` : sql``;
  return chunked(bound, columns.length + 1, where.values.length).map((chunk) => {
    const legs = chunk.map(
      (row) =>
        sql`select ${join([
          sql`${row.key}`,
          ...columns.map((column) =>
            json.has(column)
              ? sql`${row.values.get(column)}::text::jsonb`
              : sql`${row.values.get(column)}`,
          ),
        ])}`,
    );
    const source = join([head, ...legs], ' union all ');
    return sql`update ${table} set ${set} from (${source}) as ${SOURCE} where ${table}.${identifier(
      keyColumn,
    )} = ${SOURCE}.${identifier(KEY_ALIAS)} and ${where}${tail}`;
  });
};
