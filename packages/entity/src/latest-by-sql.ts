// Single responsibility: compile a newest-row-per-group plan (`latest-by.ts`) into ONE statement.
// No keys: `select distinct on (group) … order by group, order…, key`. Keys (a preload's parents):
// the keys as a typed source, `cross join lateral` a `limit n` read per key — n rows per parent
// off an index, never every row of every parent. Every identifier is the entity's; values bind.

import { identifier, join, type SqlFragment, sql } from '@ultimat3/db';
import { columnFor } from './column';
import type { EntityCore } from './entity';
import { allColumns, columnsOf, physicalName } from './pg-row';
import { conditions, orderSql, type ReadShape } from './pg-sql';
import type { QueryPlan } from './tenancy';

/**
 * The aliases written here. Upper case, which no physical column can be (`seekAlias` and
 * `pg-update-many-sql.ts` rely on the same rule), so a scope's unqualified `"org_id" = $n` inside
 * the lateral read can never resolve to one of them.
 */
const KEYS = identifier('K$LB');
const KEY = identifier('V$LB');
const PICKED = identifier('L$LB');

/**
 * The columns a row is read with: every one, or the projection plus what the read itself needs —
 * the primary key, the group and the order keys, exactly as a page's projection carries its cursor
 * keys. Physical names, one list, so the lateral's output and the outer `select` agree.
 */
const projectionOf = <Row>(entity: EntityCore<Row>, plan: QueryPlan): readonly string[] => {
  if (plan.select === undefined) return allColumns(entity);
  const wanted = new Set([
    ...plan.select,
    ...entity.$primaryKey,
    ...plan.orderBy.map((entry) => entry.column.split('.')[0] ?? entry.column),
  ]);
  return [...wanted].flatMap((property) => {
    const column = columnFor(entity.$columns, property);
    return column === undefined ? [] : columnsOf(property, column);
  });
};

/**
 * Every matched group's first row. `plan.orderBy` leads with the group (`latestPlanOf`), which is
 * what `DISTINCT ON` requires of the `order by`; `limit` is one group past the bound, whose
 * presence is the refusal (`assertGroupBound`).
 */
export const distinctOnStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  limit: number,
): SqlFragment => {
  const [group] = plan.orderBy;
  const groupColumn = identifier(physicalName(entity, group?.column ?? ''));
  return sql`select distinct on (${groupColumn}) ${join(
    projectionOf(entity, plan).map(identifier),
  )} from ${identifier(entity.$table)} where ${conditions(entity, plan, shape)} order by ${orderSql(
    entity,
    plan.orderBy,
  )} limit ${limit}`;
};

/**
 * `perGroup` rows for each key. The keys are a source typed by the TABLE — a `where false` head on
 * the group column, `union all` one bound `select $n` per key — because a bare bound list resolves
 * as `text` and `uuid = text` refuses the join (measured in sweep 5a, `pg-update-many-sql.ts`).
 * The lateral read is the plan minus its leading group key (constant inside it), under the plan's
 * scope, which already carries the `in` over these keys. The outer order restates the plan's, so
 * the rows arrive grouped and in order whatever join the planner picks.
 */
export const lateralStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  keys: readonly unknown[],
  perGroup: number,
): SqlFragment => {
  const [group, ...within] = plan.orderBy;
  const groupName = physicalName(entity, group?.column ?? '');
  const groupColumn = identifier(groupName);
  const table = identifier(entity.$table);
  const columns = projectionOf(entity, plan);
  const head = sql`select ${groupColumn} as ${KEY} from ${table} where false`;
  const source = join([head, ...keys.map((key) => sql`select ${key}`)], ' union all ');
  const inner = sql`select ${join(columns.map(identifier))} from ${table} where ${groupColumn} = ${KEYS}.${KEY} and ${conditions(
    entity,
    plan,
    shape,
  )} order by ${orderSql(entity, within)} limit ${perGroup}`;
  return sql`select ${join(columns.map((column) => sql`${PICKED}.${identifier(column)}`))} from (${source}) as ${KEYS} cross join lateral (${inner}) as ${PICKED} order by ${orderSql(
    entity,
    plan.orderBy,
    PICKED,
  )}`;
};
