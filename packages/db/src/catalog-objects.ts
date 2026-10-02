// Single responsibility: the catalog queries for every object that is NOT a table — extensions,
// enum and domain types, views, functions, triggers — plus the list of objects the schema dump has
// no statement for. Flat rows; `introspect-catalog.ts` folds and sorts them.

import { notExtensionOwned } from './catalog-relations';
import type { DbClient } from './client';
import { sql } from './sql';

export interface NameRow {
  readonly name: string;
}

export interface EnumRow {
  readonly name: string;
  readonly label: string;
  readonly position: number;
}

export interface DomainRow {
  readonly name: string;
  readonly base_type: string;
  readonly not_null: boolean;
  readonly expression: string | null;
}

export interface DomainCheckRow {
  readonly domain_name: string;
  readonly name: string;
  readonly definition: string;
}

export interface ViewRow {
  readonly name: string;
  readonly kind: string;
  readonly options: string | null;
  readonly definition: string;
}

export interface FunctionRow {
  readonly name: string;
  readonly arguments: string;
  readonly definition: string;
}

export interface TriggerRow {
  readonly table_name: string;
  readonly name: string;
  readonly definition: string;
  readonly enabled: string;
}

export interface UnrenderedRow {
  readonly kind: string;
  readonly name: string;
  readonly table_name: string | null;
}

/**
 * Database-wide, so no schema filter. `plpgsql` is left out: every database has it, `create
 * extension` on it is a no-op, and a dump line that can never differ is noise in every app.
 */
export const extensionRows = (client: DbClient): Promise<readonly NameRow[]> =>
  client.query<NameRow>(sql`select extname as name from pg_extension where extname <> 'plpgsql'`);

export const enumRows = (client: DbClient, schema: string): Promise<readonly EnumRow[]> =>
  client.query<EnumRow>(sql`
    select t.typname as name, e.enumlabel as label, e.enumsortorder::float8 as position
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = ${schema} and ${notExtensionOwned('pg_type', 't.oid')}
  `);

export const domainRows = (client: DbClient, schema: string): Promise<readonly DomainRow[]> =>
  client.query<DomainRow>(sql`
    select
      t.typname as name,
      format_type(t.typbasetype, t.typtypmod) as base_type,
      t.typnotnull as not_null,
      t.typdefault as expression
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = ${schema} and t.typtype = 'd' and ${notExtensionOwned('pg_type', 't.oid')}
  `);

export const domainCheckRows = (
  client: DbClient,
  schema: string,
): Promise<readonly DomainCheckRow[]> =>
  client.query<DomainCheckRow>(sql`
    select t.typname as domain_name, k.conname as name, pg_get_constraintdef(k.oid) as definition
    from pg_constraint k
    join pg_type t on t.oid = k.contypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = ${schema} and k.contype = 'c'
  `);

/** The non-pretty `pg_get_viewdef`: the pretty form's line breaks follow a width, not the query. */
export const viewRows = (client: DbClient, schema: string): Promise<readonly ViewRow[]> =>
  client.query<ViewRow>(sql`
    select
      c.relname as name,
      c.relkind as kind,
      array_to_string(c.reloptions, ', ') as options,
      pg_get_viewdef(c.oid) as definition
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relkind in ('v', 'm')
      and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

/** Functions, procedures and window functions. An aggregate is refused by `pg_get_functiondef`. */
export const functionRows = (client: DbClient, schema: string): Promise<readonly FunctionRow[]> =>
  client.query<FunctionRow>(sql`
    select
      p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema}
      and p.prokind in ('f', 'p', 'w')
      and ${notExtensionOwned('pg_proc', 'p.oid')}
  `);

/**
 * `not tgisinternal`: a foreign key's own enforcement triggers are the constraint's, not the app's.
 * A trigger on an extension-owned table is skipped with its table: the dump creates no such table,
 * so its `09_triggers/` file could never load.
 */
export const triggerRows = (client: DbClient, schema: string): Promise<readonly TriggerRow[]> =>
  client.query<TriggerRow>(sql`
    select
      c.relname as table_name,
      t.tgname as name,
      pg_get_triggerdef(t.oid) as definition,
      t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and not t.tgisinternal
      and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

/**
 * What exists in the schema and the dump cannot spell. One query, one closed list — a kind added
 * here is a kind the dump admits it does not carry, and a kind rendered later leaves this list in
 * the same diff.
 *
 * The last four are facts ABOUT an object the dump does render, and each was absent from both the
 * dump and this list: `create statistics`, `force row level security` (a second flag beside
 * `relrowsecurity`), a column whose `set storage` departs from its type's own, and a materialized
 * view created `with no data` — which the dump's `create materialized view` would populate. A
 * load-equals-replay check cannot see any of them, because both sides are this same reading.
 *
 * A trigger on a relation the dump does not create is the one kind NOT read here: which relations
 * are rendered is the fold's answer, so `introspectCatalog` names those itself.
 */
export const unrenderedRows = (
  client: DbClient,
  schema: string,
): Promise<readonly UnrenderedRow[]> =>
  client.query<UnrenderedRow>(sql`
    select kind, name, table_name from (
      select
        case
          when c.relkind = 'p' then 'partitioned table'
          when c.relkind = 'f' then 'foreign table'
          when c.relkind = 'c' then 'composite type'
          else 'partition or inheritance child'
        end as kind,
        c.relname as name,
        null::text as table_name,
        c.relnamespace as namespace
      from pg_class c
      where (
          c.relkind in ('p', 'f', 'c')
          or (c.relkind = 'r' and (
            c.relispartition or exists (select 1 from pg_inherits h where h.inhrelid = c.oid)
          ))
        )
        and ${notExtensionOwned('pg_class', 'c.oid')}
      union all
      select 'range type', t.typname, null::text, t.typnamespace
      from pg_type t
      where t.typtype = 'r' and ${notExtensionOwned('pg_type', 't.oid')}
      union all
      select 'aggregate', p.proname, null::text, p.pronamespace
      from pg_proc p
      where p.prokind = 'a' and ${notExtensionOwned('pg_proc', 'p.oid')}
      union all
      select 'row security policy', pol.polname, c.relname, c.relnamespace
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      union all
      select 'row security', c.relname, c.relname, c.relnamespace
      from pg_class c
      where c.relrowsecurity
      union all
      select 'rule', r.rulename, c.relname, c.relnamespace
      from pg_rewrite r
      join pg_class c on c.oid = r.ev_class
      where r.rulename <> '_RETURN'
      union all
      select 'extended statistics', s.stxname, c.relname, s.stxnamespace
      from pg_statistic_ext s
      join pg_class c on c.oid = s.stxrelid
      union all
      select 'forced row security', c.relname, c.relname, c.relnamespace
      from pg_class c
      where c.relforcerowsecurity
      union all
      select 'column storage', a.attname, c.relname, c.relnamespace
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_type t on t.oid = a.atttypid
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and a.attstorage <> t.typstorage
        and ${notExtensionOwned('pg_class', 'c.oid')}
      union all
      select 'unpopulated materialized view', c.relname, null::text, c.relnamespace
      from pg_class c
      where c.relkind = 'm' and not c.relispopulated
    ) objects
    join pg_namespace n on n.oid = objects.namespace
    where n.nspname = ${schema}
  `);
