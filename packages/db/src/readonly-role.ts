// Single responsibility: LAYER 1 of `db.query`'s defence-in-depth — a Postgres role that can
// only SELECT. A grant set is the layer that survives a bug in every other layer, because
// Postgres itself refuses the write. `NOLOGIN` means it is reachable only via `SET LOCAL ROLE`
// inside an already-`READ ONLY` transaction, never by a connection string.

import type { DbClient } from './client';
import { identifier, literal, raw, type SqlFragment, sql } from './sql';

/** The role `ensureReadOnlyRole` creates and `readOnlyQuery` assumes by default. */
export const READONLY_ROLE = 'ultimate_readonly';

export interface ReadOnlyRoleOptions {
  readonly role?: string | undefined;
  readonly schema?: string | undefined;
  /**
   * The roles that CREATE objects in `schema` — in practice whoever runs the migrations.
   * Postgres scopes `ALTER DEFAULT PRIVILEGES` to objects created by the roles it names, so when
   * migrations run as a different user than this DDL, every table created afterwards is
   * unreadable by the read-only role and layer 1 quietly stops covering new tables. Defaults to
   * the connected user; naming another role requires membership in it.
   */
  readonly creators?: readonly string[] | undefined;
}

/**
 * `CURRENT_USER` is a keyword, not an identifier — quoting it would name a role actually called
 * "current_user", so it stays bare exactly like `GRANT ... TO CURRENT_USER` below.
 */
function creatorRefs(creators: readonly string[] | undefined): readonly SqlFragment[] {
  // Absent *or* empty means "whoever is connected", never "no creators": the second reading would
  // silently drop the layer for every object created after this DDL.
  if (creators === undefined || creators.length === 0) return [raw('CURRENT_USER')];
  return creators.map((creator) => identifier(creator));
}

/**
 * Emitted once per creating role, because Postgres applies `ALTER DEFAULT PRIVILEGES` only to
 * objects created by the roles it names. Without the pair its own defaults work against us: a
 * table created after this DDL is invisible to SELECT while a new sequence is readable —
 * backwards for a role that must stay read-only forever, not just at grant time.
 */
function defaultPrivileges(
  creator: SqlFragment,
  role: string,
  schema: string,
): readonly SqlFragment[] {
  return [
    sql`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${creator} IN SCHEMA ${identifier(schema)}
      GRANT SELECT ON TABLES TO ${identifier(role)}
    `,
    sql`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${creator} IN SCHEMA ${identifier(schema)}
      REVOKE ALL ON SEQUENCES FROM ${identifier(role)}
    `,
  ];
}

/** The idempotent DDL that creates and re-grants the role. Safe to run at every boot. */
export function grantReadOnlySql(options?: ReadOnlyRoleOptions): readonly SqlFragment[] {
  const role = options?.role ?? READONLY_ROLE;
  const schema = options?.schema ?? 'public';

  return [
    // `CREATE ROLE` has no `IF NOT EXISTS`, so the guard is a DO block. The name is compared as
    // a string literal (`literal()`) in the check and quoted as an identifier (`identifier()`)
    // where it names the role — never spliced in as bare text either way.
    sql`
      DO $ultimate$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
          CREATE ROLE ${identifier(role)} NOLOGIN NOINHERIT;
        END IF;
      END $ultimate$
    `,
    // NOLOGIN roles are only usable by their members, so the connected user needs membership
    // before it can ever `SET LOCAL ROLE` into this one.
    sql`GRANT ${identifier(role)} TO CURRENT_USER`,
    sql`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(role)}`,
    sql`GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(schema)} TO ${identifier(role)}`,
    // Sequences expose nextval/currval, which leaks row counts and (with USAGE) lets a "reader"
    // advance state other transactions depend on — read-only excludes them outright.
    sql`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${identifier(schema)} FROM ${identifier(role)}`,
    // Two per creating role: what the grants above cover is the schema as it is *now*, and
    // `ALTER DEFAULT PRIVILEGES` is the only thing that covers what lands in it next.
    ...creatorRefs(options?.creators).flatMap((creator) =>
      defaultPrivileges(creator, role, schema),
    ),
  ];
}

/**
 * Create/refresh the role and make it assumable by the current user.
 *
 * Returns the role name when the role exists and may be assumed, `null` when the connection is
 * not allowed to create or grant roles (a managed Postgres where the app user is not a role
 * admin). Never throws: the other three layers still hold without this one, and the caller
 * reports the missing layer instead of losing all four to an exception.
 */
export async function ensureReadOnlyRole(
  client: DbClient,
  options?: ReadOnlyRoleOptions,
): Promise<string | null> {
  const role = options?.role ?? READONLY_ROLE;
  try {
    for (const statement of grantReadOnlySql(options)) {
      await client.execute(statement);
    }
    return role;
  } catch {
    // Swallowed deliberately: a managed Postgres often refuses CREATE ROLE / GRANT to the app
    // user. The other three layers (read-only transaction, statement timeout, pre-parse scan)
    // still hold — the caller reports this layer as degraded rather than the boot crashing.
    return null;
  }
}
