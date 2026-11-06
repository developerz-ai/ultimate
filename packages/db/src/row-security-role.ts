// Single responsibility: is the role this process serves as subject to row security at all.
// Postgres exempts a superuser, a `bypassrls` role, and a table's owner unless the table FORCES it;
// a policy over any of those refuses nothing. Read off `current_user`'s attributes, never a name.

import type { DbClient } from './client';
import { DbError } from './errors';
import { sql } from './sql';

export interface RowSecurityRole {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** Tables this role owns with row security enabled and not forced: the owner sees every row. */
  readonly ownedUnforced: number;
}

interface RoleRow {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypass: boolean;
  readonly unforced: number;
}

/** The attributes, read once. `x doctor` lists them; the boot judges them. */
export async function rowSecurityRole(client: DbClient): Promise<RowSecurityRole> {
  const row = await client.one<RoleRow>(sql`
    select r.rolname as role, r.rolsuper as superuser, r.rolbypassrls as bypass,
      (select count(*) from pg_class c
        where c.relowner = r.oid and c.relrowsecurity and not c.relforcerowsecurity)::int as unforced
    from pg_roles r where r.rolname = current_user`);
  return {
    role: row?.role ?? '',
    superuser: row?.superuser === true,
    bypassRls: row?.bypass === true,
    ownedUnforced: Number(row?.unforced ?? 0),
  };
}

/** Why `role` is exempt, or `undefined` when row security binds it. */
export function rowSecurityExemption(role: RowSecurityRole): string | undefined {
  if (role.superuser) return 'is a superuser';
  if (role.bypassRls) return 'has bypassrls';
  if (role.ownedUnforced > 0) {
    return `owns ${String(role.ownedUnforced)} table(s) with row security enabled and not forced`;
  }
  return undefined;
}

/** `X_DB_ROW_SECURITY_BYPASSED` when the serving role would see every tenant's rows. */
export async function assertRowSecurityBinds(client: DbClient): Promise<void> {
  const role = await rowSecurityRole(client);
  const exemption = rowSecurityExemption(role);
  if (exemption === undefined) return;
  throw new DbError({
    code: 'X_DB_ROW_SECURITY_BYPASSED',
    cause: `database.rowSecurity is on and the connected role ${JSON.stringify(role.role)} ${exemption}, which Postgres exempts from every policy`,
    fix: 'psql "$DATABASE_URL" -c \'alter role <role> nosuperuser nobypassrls\'  # and serve as a role that owns no table: the migrator owns them, ROLE=migrate',
    meta: { role: role.role, superuser: role.superuser, bypassRls: role.bypassRls },
  });
}
