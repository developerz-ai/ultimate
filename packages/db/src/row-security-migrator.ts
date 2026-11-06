// Single responsibility: an embedded database's migrate step, held as `x_migrator`. On PGlite the
// one session is a superuser, so without this every table belongs to it and the default privileges
// `x_migrator` sets for `x_app` never apply. What the superuser already owns in `public` is handed
// over first — a table created before the flag must still be alterable by the next migration.

import type { DbClient } from './client';
import { ensureRowSecurityRoles, MIGRATOR_ROLE } from './row-security-roles';
import { identifier, raw } from './sql';

/**
 * Every relation, type and routine in `public` the session's user owns, given to the migrator. A
 * sequence a column owns follows its table (`alter sequence` on it is refused); an extension's
 * member objects stay the extension's.
 */
export function migratorOwnershipSql(): string {
  const migrator = identifier(MIGRATOR_ROLE).text;
  const member = (catalog: string): string =>
    `not exists (select from pg_depend d where d.classid = '${catalog}'::regclass and d.objid = o.oid and d.deptype in ('a', 'i', 'e'))`;
  return (
    'do $own$ declare r record; begin ' +
    'for r in select o.oid::regclass as name, ' +
    "case o.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end as kind " +
    "from pg_class o where o.relnamespace = 'public'::regnamespace and o.relkind in ('r', 'p', 'v', 'm', 'S', 'f') " +
    `and o.relowner = (select oid from pg_roles where rolname = current_user) and ${member('pg_class')} loop ` +
    `execute format('alter %s %s owner to ${migrator}', r.kind, r.name); end loop; ` +
    "for r in select o.oid::regtype as name from pg_type o where o.typnamespace = 'public'::regnamespace and o.typtype in ('e', 'd', 'r', 'm') " +
    `and o.typowner = (select oid from pg_roles where rolname = current_user) and ${member('pg_type')} loop ` +
    `execute format('alter type %s owner to ${migrator}', r.name); end loop; ` +
    "for r in select o.oid::regprocedure as name from pg_proc o where o.pronamespace = 'public'::regnamespace " +
    `and o.proowner = (select oid from pg_roles where rolname = current_user) and ${member('pg_proc')} loop ` +
    `execute format('alter routine %s owner to ${migrator}', r.name); end loop; ` +
    'end $own$'
  );
}

/**
 * The roles, the hand-over, then `set role x_migrator` for the migrate step's scope. Returns the
 * undo: `reset role`, so the session is the bootstrap user again for whatever runs next. Only on an
 * engine whose roles are ours: an external database's migrator is the operator's `DATABASE_URL`.
 */
export async function holdMigratorRole(client: DbClient): Promise<() => Promise<void>> {
  await ensureRowSecurityRoles(client);
  await client.execute(raw(migratorOwnershipSql()));
  await client.execute(raw(`set role ${identifier(MIGRATOR_ROLE).text}`));
  return async () => {
    await client.execute(raw('reset role'));
  };
}
