// Single responsibility: row security as the catalog holds it — which tables enable or force it,
// and every policy on them, clause by clause — read and folded for the schema dump. A dump without
// them loads a test database that refuses nothing, so a policy would be untested and prod-only.

import type { CatalogPolicy, CatalogRowSecurity } from './catalog';
import { by } from './catalog-fold';
import { notExtensionOwned } from './catalog-relations';
import type { DbClient } from './client';
import { sql } from './sql';

export interface RowSecurityRow {
  readonly table_name: string;
  readonly enabled: boolean;
  readonly forced: boolean;
}

export interface PolicyRow {
  readonly table_name: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly with_check: string | null;
}

export const rowSecurityRows = (
  client: DbClient,
  schema: string,
): Promise<readonly RowSecurityRow[]> =>
  client.query<RowSecurityRow>(sql`
    select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and (c.relrowsecurity or c.relforcerowsecurity)
      and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

/** `polroles` holds `0` for `public`, which no `pg_roles` row answers; each name is resolved here. */
export const policyRows = (client: DbClient, schema: string): Promise<readonly PolicyRow[]> =>
  client.query<PolicyRow>(sql`
    select
      c.relname as table_name,
      p.polname as name,
      p.polpermissive as permissive,
      case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update'
        when 'd' then 'delete' else 'all' end as command,
      array(
        select case when r.oid = 0 then 'public' else (select rolname from pg_roles where oid = r.oid) end
        from unnest(p.polroles) as r(oid)
      ) as roles,
      pg_get_expr(p.polqual, p.polrelid) as using,
      pg_get_expr(p.polwithcheck, p.polrelid) as with_check
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and ${notExtensionOwned('pg_class', 'c.oid')}
  `);

export const rowSecurityOf = (rows: readonly RowSecurityRow[]): readonly CatalogRowSecurity[] =>
  rows
    .map((row) => ({ table: row.table_name, enabled: row.enabled, forced: row.forced }))
    .sort(by((entry) => entry.table));

export const policiesOf = (rows: readonly PolicyRow[]): readonly CatalogPolicy[] =>
  rows
    .map((row) => ({
      table: row.table_name,
      name: row.name,
      permissive: row.permissive,
      command: row.command,
      roles: [...row.roles].sort(by((role) => role)),
      using: row.using,
      withCheck: row.with_check,
    }))
    .sort(
      by(
        (policy) => policy.table,
        (policy) => policy.name,
      ),
    );
