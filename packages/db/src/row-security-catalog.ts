// Single responsibility: the catalog's half of a table's row security, as names — the policies on
// each table whose row security is enabled AND forced. A policy on a table that is not forced binds
// no owner, and one on a table that is not enabled binds nobody, so neither is held.

import type { DbClient } from './client';
import { sql } from './sql';

/** One policy on a table whose row security binds: what `introspectSchema()` reads. */
export interface PolicyNameRow {
  readonly table_name: string;
  readonly policy_name: string;
}

/** Names only, as `triggerNames`: a guard is judged by being THERE, never by `pg_get_expr` text. */
export const policyNameRows = (
  client: DbClient,
  schema: string,
): Promise<readonly PolicyNameRow[]> =>
  client.query<PolicyNameRow>(sql`
    select c.relname as table_name, p.polname as policy_name
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relrowsecurity and c.relforcerowsecurity
    order by c.relname, p.polname
  `);
