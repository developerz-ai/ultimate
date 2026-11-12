// Single responsibility: a schema's indexes read out of `pg_index` and folded into
// `IndexDescription`s — keys in key order, the method, and the key parts past a plain column list
// (per-key directions, INCLUDE, a non-default operator class). Split from `introspect.ts` at the
// 500-line ceiling; each newer part is written only when present, so an index without is unchanged.

import type { DbClient } from './client';
import type { IndexDescription } from './introspect';
import type { IndexRow } from './introspect-rows';
import { sql } from './sql';

/** The row, plus the key-part columns. Optional: a stub's rows predate them and read as "none". */
export interface IndexKeyRow extends IndexRow {
  /** `true` per key that is descending, in key order. */
  readonly directions?: readonly boolean[] | undefined;
  /** INCLUDE payload columns, in order; `null` when there are none. */
  readonly include?: readonly string[] | null | undefined;
  /** Per key: the operator class when it is NOT the type's default, else `null`. */
  readonly opclasses?: readonly (string | null)[] | undefined;
}

/**
 * Ordered by the index's own key position, never by `attnum`: `indkey` IS the order the planner
 * sorts by. `indnkeyatts` splits keys from INCLUDE payload columns, which are stored, not keyed.
 *
 * A LEFT join on `pg_attribute`: an expression key has `attnum = 0` and no attribute row, so an
 * inner join dropped it and `(id, lower(title))` read back as `(id)`. It is kept in its position
 * and MARKED by its parentheses, which no declared column name carries.
 *
 * `indclass` is the operator class per key; only a non-default one is named (`opcdefault`), so a
 * jsonb GIN's own `jsonb_ops` reads as nothing declared, which is what its declaration says.
 */
export const indexRows = (client: DbClient, schema: string): Promise<readonly IndexKeyRow[]> =>
  client.query<IndexKeyRow>(sql`
    select
      t.relname as table_name,
      i.relname as index_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      pg_get_expr(ix.indpred, ix.indrelid) as predicate,
      am.amname as method,
      array_agg(
        coalesce(a.attname::text, '(' || pg_get_indexdef(ix.indexrelid, k.ord::int, false) || ')')
        order by k.ord
      ) as columns,
      bool_and((ix.indoption[k.ord - 1] & 1) = 1) as descending,
      array_agg((ix.indoption[k.ord - 1] & 1) = 1 order by k.ord) as directions,
      array_agg(case when opc.opcdefault then null else opc.opcname::text end order by k.ord)
        as opclasses,
      (
        select array_agg(pa.attname::text order by p.ord)
        from unnest(ix.indkey::smallint[]) with ordinality as p(attnum, ord)
        join pg_attribute pa on pa.attrelid = t.oid and pa.attnum = p.attnum
        where p.ord > ix.indnkeyatts
      ) as include
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace
    join pg_index ix on ix.indrelid = t.oid
    join pg_class i on i.oid = ix.indexrelid
    join pg_am am on am.oid = i.relam
    cross join lateral unnest(ix.indkey::smallint[]) with ordinality as k(attnum, ord)
    left join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum and k.attnum > 0
    left join pg_opclass opc on opc.oid = ix.indclass[k.ord - 1]
    where n.nspname = ${schema} and t.relkind in ('r', 'p') and k.ord <= ix.indnkeyatts
    group by
      t.oid, t.relname, i.relname, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid,
      ix.indexrelid, ix.indkey, ix.indnkeyatts, am.amname
    order by t.relname, i.relname
  `);

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

/**
 * The parts past a plain column list, each only when the catalog holds one: `orders` only for MIXED
 * directions (all-descending is `order: 'desc'`, the reading every snapshot already has), INCLUDE
 * only when non-empty, an operator class only when every key carries the same non-default one.
 */
function keyPartsOf(row: IndexKeyRow): Partial<IndexDescription> {
  const directions = row.directions ?? [];
  const mixed = directions.some((d) => d) && directions.some((d) => !d);
  const classes = new Set(row.opclasses ?? []);
  const [onlyClass] = classes;
  return {
    ...(mixed ? { orders: directions.map((d) => (d ? ('desc' as const) : null)) } : {}),
    ...(row.include === null || row.include === undefined || row.include.length === 0
      ? {}
      : { include: [...row.include] }),
    ...(classes.size === 1 && typeof onlyClass === 'string' ? { operatorClass: onlyClass } : {}),
  };
}

/** One table's indexes, by name. */
export function indexesOf(rows: readonly IndexKeyRow[], table: string): IndexDescription[] {
  return rows
    .filter((row) => row.table_name === table)
    .map(
      (row): IndexDescription => ({
        name: row.index_name,
        columns: [...row.columns],
        unique: row.is_unique,
        primary: row.is_primary,
        where: row.predicate,
        order: row.descending ? ('desc' as const) : null,
        // `exactOptionalPropertyTypes`: a row with no method is a stub's, and absent must stay
        // absent rather than becoming an explicit `undefined` a strict comparison can see.
        ...(row.method === undefined ? {} : { using: row.method }),
        ...keyPartsOf(row),
      }),
    )
    .sort(byName);
}
