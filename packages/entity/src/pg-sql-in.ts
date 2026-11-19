// Single responsibility: compile an `in` list to SQL — the `in ($1, …)` it always was, or one array
// parameter once the list is long enough to spend the statement's bind budget on its own.

import { join, type SqlFragment, sql } from '@ultimat3/db';
import { arrayLiteral } from './pg-row';
import { bindsAsArray } from './predicate-operand';
import type { ColumnKind } from './types';

/** Nothing matches. `in ()` is a syntax error in Postgres, so an empty set needs a constant. */
export const NEVER = sql`1 = 0`;

/**
 * `in` reads a LIST or nothing. A scalar used to be wrapped into a one-element list, which matched
 * a row here that `memoryRepo`'s `matches` refuses outright — 0 rows in memory, 1 in Postgres, from
 * a call `andWhere(column, op, value: unknown)` compiles. One answer, and it is the one
 * `@ultimat3/query`'s `filterClause` already gives: no rows.
 *
 * A NULL bound as a parameter is `col = null`, which is UNKNOWN and therefore excludes the very row
 * the caller listed — while memory's `sameValue(null, null)` includes it. Postgres has no `in` that
 * compares a null as a value, so the list is partitioned and the nulls are asked for as `is null`:
 * the `(… in (…) or … is null)` pair `eq` and `neq` already emit.
 *
 * A list past `IN_LIST_AS_ARRAY_FROM` is `= any($1)`: one parameter, the array literal, typed by
 * the column it is compared to. Bound one by one, 65,536 values are `08P01` — or a dropped
 * connection (measured on `Bun.SQL`: `X_DB_UNAVAILABLE`) — for a list memory answers. The planner
 * reads both spellings as the same `ScalarArrayOpExpr`, so the index serves either.
 */
export const inListSql = (
  column: SqlFragment,
  kind: ColumnKind | undefined,
  value: unknown,
): SqlFragment => {
  if (!Array.isArray(value)) return NEVER;
  const present = value.filter((each) => each !== null && each !== undefined);
  const list =
    present.length === 0
      ? undefined
      : bindsAsArray(kind, present.length)
        ? sql`${column} = any(${arrayLiteral(present)})`
        : sql`${column} in (${join(present.map((each) => sql`${each}`))})`;
  const nulls = present.length === value.length ? undefined : sql`${column} is null`;
  if (list === undefined) return nulls ?? NEVER;
  return nulls === undefined ? list : sql`(${list} or ${nulls})`;
};
