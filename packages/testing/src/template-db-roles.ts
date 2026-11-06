// Single responsibility: the template database of a `database.rowSecurity` app — the two roles
// `@ultimat3/db` declares, made able to log in, the migrator migrating and the app role serving. The
// bootstrap user (`ultimate`, a superuser) would see every tenant's rows, so a suite never serves as it.

import { APP_ROLE, MIGRATOR_ROLE, rowSecurityRolesSql } from '@ultimat3/db';
import type { SqlRunner } from './template-db';

type RowSecurityRole = typeof APP_ROLE | typeof MIGRATOR_ROLE;

/**
 * Test-services credentials only — the role's own name as its password, as `ultimate:ultimate` is.
 * A production role's credentials are the operator's and never written by the framework.
 */
export const loginSql = (role: RowSecurityRole): string =>
  `ALTER ROLE "${role}" LOGIN PASSWORD '${role}'`;

/** `url` with its credentials swapped for `role`'s, database and parameters kept. */
export function asRole(url: string, role: RowSecurityRole): string {
  const next = new URL(url);
  next.username = role;
  next.password = role;
  return next.toString();
}

/**
 * Run in the TEMPLATE, before it is migrated: roles are the cluster's, but the schema grants and
 * the default privileges that make a migrator's later table reachable live in the database, and
 * every clone inherits them.
 */
export async function prepareRowSecurity(
  connect: (url: string) => SqlRunner,
  templateUrl: string,
): Promise<void> {
  const runner = connect(templateUrl);
  try {
    for (const statement of rowSecurityRolesSql()) await runner.exec(statement);
    await runner.exec(loginSql(APP_ROLE));
    await runner.exec(loginSql(MIGRATOR_ROLE));
  } finally {
    await runner.close();
  }
}

/** Where `migrate` runs and where a suite connects, with row security on and off. */
export const rowSecurityUrls = (
  enabled: boolean,
  url: string,
): { readonly migrate: string; readonly serve: string } =>
  enabled
    ? { migrate: asRole(url, MIGRATOR_ROLE), serve: asRole(url, APP_ROLE) }
    : { migrate: url, serve: url };
