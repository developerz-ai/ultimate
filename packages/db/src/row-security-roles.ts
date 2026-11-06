// Single responsibility: the two roles row security needs on an engine whose own user is a
// superuser — PGlite's default role, and the test services' `ultimate`. The app role serves and is
// subject to every policy; the migrator owns the tables and bypasses them, so a backfill or a key
// validate still sees every row. Idempotent: run on every boot of a flag-on database.

import type { DbClient } from './client';
import { identifier, raw } from './sql';

/** `nosuperuser nobypassrls`, owning nothing: the role a request runs as. */
export const APP_ROLE = 'x_app';
/** `bypassrls`, owning every table: the role `ROLE=migrate` runs as. */
export const MIGRATOR_ROLE = 'x_migrator';

/**
 * The statements, in order. Created only when absent (`create role` has no `if not exists`),
 * attributes re-asserted every time so a role an operator altered by hand is put back. The
 * bootstrap user may switch into both. Text, so a runner with no `DbClient` (`@ultimat3/testing`'s
 * template database) runs the same list.
 */
export function rowSecurityRolesSql(): readonly string[] {
  const app = identifier(APP_ROLE).text;
  const migrator = identifier(MIGRATOR_ROLE).text;
  const later = (grant: string): string =>
    `alter default privileges for role ${migrator} in schema public grant ${grant} to ${app}`;
  return [
    'do $roles$ begin ' +
      `if not exists (select from pg_roles where rolname = '${APP_ROLE}') then create role ${app}; end if; ` +
      `if not exists (select from pg_roles where rolname = '${MIGRATOR_ROLE}') then create role ${migrator}; end if; ` +
      'end $roles$',
    `alter role ${app} nosuperuser nobypassrls nocreaterole nocreatedb`,
    `alter role ${migrator} nosuperuser bypassrls`,
    `grant ${app}, ${migrator} to current_user`,
    // What the migrator creates later, the app role can reach: the grants follow the table.
    `grant usage on schema public to ${app}`,
    `grant create, usage on schema public to ${migrator}`,
    later('select, insert, update, delete on tables'),
    later('usage, select on sequences'),
  ];
}

/** Idempotent: run on every boot of a flag-on database. */
export async function ensureRowSecurityRoles(client: DbClient): Promise<void> {
  for (const statement of rowSecurityRolesSql()) await client.execute(raw(statement));
}

/** `set role` on a session — PGlite's one, or a test connection — for the rest of its life. */
export function assumeRole(client: DbClient, role: typeof APP_ROLE | typeof MIGRATOR_ROLE) {
  return client.execute(raw(`set role ${identifier(role).text}`));
}

/**
 * On an engine whose roles are ours (PGlite, whose one session is a superuser): the roles, DML on
 * every table and sequence already there — the framework's `x_*` and any table a superuser created
 * before the flag — then the session serves as `x_app` for the rest of its life. Idempotent.
 */
export async function serveAsAppRole(client: DbClient): Promise<void> {
  const app = identifier(APP_ROLE).text;
  await ensureRowSecurityRoles(client);
  await client.execute(
    raw(`grant select, insert, update, delete on all tables in schema public to ${app}`),
  );
  await client.execute(raw(`grant usage, select on all sequences in schema public to ${app}`));
  await assumeRole(client, APP_ROLE);
}
