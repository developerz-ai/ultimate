// Single responsibility: the catalog queries for what a TABLE is — the relation, its columns, its
// constraints, its sequences and its indexes — as flat rows. Nothing here folds or sorts:
// `introspect-catalog.ts` does, in JS, because `order by` on a name follows the server's collation
// and two servers do not share one.

import type { DbClient } from './client';
import { raw, type SqlFragment, sql } from './sql';

/**
 * "No extension owns this object" — `pg_depend`'s `deptype = 'e'` row, the rule `app-relation.ts`
 * already holds for relations, asked of whichever catalog the object lives in. Both arguments are
 * literals at every call site, never data.
 */
export const notExtensionOwned = (
  catalog: 'pg_class' | 'pg_type' | 'pg_proc',
  oid: string,
): SqlFragment =>
  raw(
    `not exists (select 1 from pg_depend e where e.classid = '${catalog}'::regclass ` +
      `and e.objid = ${oid} and e.refclassid = 'pg_extension'::regclass and e.deptype = 'e')`,
  );

export interface TableRow {
  readonly name: string;
  readonly persistence: string;
  readonly replica_identity: string;
  readonly replica_index: string | null;
  readonly options: string | null;
}

export interface ColumnRow {
  readonly table_name: string;
  readonly name: string;
  readonly position: number;
  readonly type: string;
  readonly not_null: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly expression: string | null;
  readonly collation: string | null;
}

export interface ConstraintRow {
  readonly table_name: string;
  readonly name: string;
  readonly type: string;
  readonly definition: string;
}

export interface SequenceRow {
  readonly name: string;
  readonly data_type: string;
  readonly seq_start: string;
  readonly seq_increment: string;
  readonly seq_min: string;
  readonly seq_max: string;
  readonly seq_cache: string;
  readonly seq_cycle: boolean;
  /** `a` — a `serial` column owns it; `i` — an identity column does; `null` — nothing does. */
  readonly ownership: string | null;
  readonly owner_table: string | null;
  readonly owner_column: string | null;
}

export interface IndexRow {
  readonly table_name: string;
  readonly name: string;
  readonly definition: string;
}

/**
 * Plain tables only. A partition, an inheritance child and a partitioned parent are `relkind`
 * `r`/`p` rows a `create table (…)` cannot rebuild, so they are named by `unrenderedRows`
 * (`catalog-objects.ts`) instead of rendered wrong here.
 */
export const tableRows = (client: DbClient, schema: string): Promise<readonly TableRow[]> =>
  client.query<TableRow>(sql`
    select
      c.relname as name,
      c.relpersistence as persistence,
      c.relreplident as replica_identity,
      (
        select i.relname
        from pg_index x
        join pg_class i on i.oid = x.indexrelid
        where x.indrelid = c.oid and x.indisreplident
      ) as replica_index,
      array_to_string(c.reloptions, ', ') as options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relkind = 'r'
      and not c.relispartition
      and not exists (select 1 from pg_inherits h where h.inhrelid = c.oid)
      and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

/** `format_type` and `pg_get_expr`, never `information_schema`: that view answers `ARRAY` and `USER-DEFINED`. */
export const columnRows = (client: DbClient, schema: string): Promise<readonly ColumnRow[]> =>
  client.query<ColumnRow>(sql`
    select
      c.relname as table_name,
      a.attname as name,
      a.attnum as position,
      format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as not_null,
      a.attidentity as identity,
      a.attgenerated as generated,
      pg_get_expr(d.adbin, d.adrelid) as expression,
      case when a.attcollation <> t.typcollation then co.collname end as collation
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_collation co on co.oid = a.attcollation
    where n.nspname = ${schema} and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  `);

/**
 * Every constraint a table carries, foreign keys included — the fold routes those to their own
 * directory. `contype = 'n'` (a NOT NULL recorded as a constraint, Postgres 18) is left out: the
 * column's own `not null` already says it, and reading it would make the dump differ by server.
 */
export const constraintRows = (
  client: DbClient,
  schema: string,
): Promise<readonly ConstraintRow[]> =>
  client.query<ConstraintRow>(sql`
    select
      c.relname as table_name,
      k.conname as name,
      k.contype as type,
      pg_get_constraintdef(k.oid) as definition
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and k.contype in ('p', 'u', 'c', 'x', 'f')
  `);

/** `::text` on every bound: a `bigint` is a string on one driver and a number on the other. */
export const sequenceRows = (client: DbClient, schema: string): Promise<readonly SequenceRow[]> =>
  client.query<SequenceRow>(sql`
    select
      c.relname as name,
      format_type(s.seqtypid, null) as data_type,
      s.seqstart::text as seq_start,
      s.seqincrement::text as seq_increment,
      s.seqmin::text as seq_min,
      s.seqmax::text as seq_max,
      s.seqcache::text as seq_cache,
      s.seqcycle as seq_cycle,
      d.deptype as ownership,
      t.relname as owner_table,
      a.attname as owner_column
    from pg_sequence s
    join pg_class c on c.oid = s.seqrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_depend d
      on d.classid = 'pg_class'::regclass and d.objid = c.oid
      and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    left join pg_class t on t.oid = d.refobjid
    left join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where n.nspname = ${schema} and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

/** Indexes no constraint backs, on a table or a materialized view. */
export const indexRows = (client: DbClient, schema: string): Promise<readonly IndexRow[]> =>
  client.query<IndexRow>(sql`
    select
      t.relname as table_name,
      i.relname as name,
      pg_get_indexdef(x.indexrelid) as definition
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = ${schema}
      and t.relkind in ('r', 'm')
      and not exists (
        select 1 from pg_constraint k
        where k.conindid = x.indexrelid and k.contype in ('p', 'u', 'x')
      )
  `);
