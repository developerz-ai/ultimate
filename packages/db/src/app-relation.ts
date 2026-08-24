// Single responsibility: name the relations in a schema that are NOT app schema, so introspection
// never puts them in a snapshot and drift can never report one. Two disqualifications, one
// question: an object an extension owns, and an object that is not a table at all.

import type { DbClient } from './client';
import { sql } from './sql';

interface NonAppRelationRow {
  readonly name: string;
}

/**
 * Relation names in `schema` that no migration could legitimately declare.
 *
 * **Extension ownership is the rule, never a name prefix.** Every object `create extension` builds
 * carries a `pg_depend` row with `deptype = 'e'` pointing at `pg_extension` — that is Postgres'
 * own record of "this belongs to an extension", and it is the only thing that generalises. A
 * prefix rule spelled `pg_*` would have covered the `pg_stat_statements` view that made every
 * deploy of the demo app fail terminally (issue #340) and missed `postgis`' `spatial_ref_sys`,
 * `timescaledb`'s catalog and `pg_stat_statements`' own `pg_stat_statements_info` sibling. An
 * extension may install a relation under any name at all, so the name is not evidence.
 *
 * **A view, a materialised view and a foreign table are not tables**, whoever created them. They
 * reach `information_schema.columns` (measured on PGlite: a plain `create view` appears there),
 * while the index query already fences on `relkind = 'r'` — so one came back as a table with
 * columns, no primary key and no indexes, which is a `TableDescription` that cannot be true. No
 * `x db gen` diff emits `create view` and no snapshot records one, so counting them as app schema
 * can only ever produce a finding an author has no way to clear.
 *
 * Excluding by NAME is safe because `pg_class` names are unique within a namespace: a name on this
 * list cannot also be an app table in the same schema.
 */
export async function nonAppRelations(
  client: DbClient,
  schema: string,
): Promise<readonly string[]> {
  const rows = await client.query<NonAppRelationRow>(sql`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema}
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        c.relkind in ('v', 'm', 'f')
        or exists (
          select 1
          from pg_depend d
          where d.classid = 'pg_class'::regclass
            and d.objid = c.oid
            and d.refclassid = 'pg_extension'::regclass
            and d.deptype = 'e'
        )
      )
    order by c.relname
  `);
  return rows.map((row) => row.name);
}
