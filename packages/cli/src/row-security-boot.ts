// Single responsibility: arming the database's tenant guard for a booted role. With
// `database.rowSecurity` on, the serving role must be one Postgres applies policies to
// (`X_DB_ROW_SECURITY_BYPASSED` otherwise), every BEGIN carries the actor's tenant, and a bare
// statement is wrapped in a transaction that does. Off, nothing here runs.

import type { AppConfig } from '@ultimat3/core';
import {
  assertRowSecurityBinds,
  db,
  holdMigratorRole,
  raw,
  rowSecureClient,
  serveAsAppRole,
  setDbClient,
  setTransactionSettings,
} from '@ultimat3/db';
import { rowSecuritySettings } from '@ultimat3/entity';
import { loadAppConfig } from './app-config-load';

/** `database.rowSecurity` on a loaded config; no `app.config.ts` at all is off. */
export function rowSecurityDeclared(config: AppConfig | undefined): boolean {
  return config?.database.rowSecurity === true;
}

/**
 * Judge the role on the ambient client, then install the seam and the wrapper. Judged FIRST: a boot
 * refused here installs nothing, so a test that catches the refusal leaves the process as it was.
 * `embedded` is PGlite, whose one session is a superuser and whose roles are ours: it switches to
 * `x_app` before the judgement (`serveAsAppRole`). An external database's roles are the operator's
 * and are only ever judged. Returns the undo, which `stop()` runs so a second boot starts clean.
 */
export async function armRowSecurity(
  enabled: boolean,
  options: { readonly embedded?: boolean } = {},
): Promise<() => Promise<void>> {
  if (!enabled) return async () => undefined;
  const ambient = db();
  if (options.embedded === true) await serveAsAppRole(ambient);
  await assertRowSecurityBinds(ambient);
  setTransactionSettings(rowSecuritySettings);
  setDbClient(rowSecureClient(ambient));
  return async () => {
    setTransactionSettings(undefined);
    setDbClient(ambient);
    if (options.embedded === true) await ambient.execute(raw('reset role'));
  };
}

/**
 * The migrate step on PGlite, whose roles are ours — never called for an external database, whose
 * migrator is the operator's `DATABASE_URL`. With the flag on, the app's migrations run as
 * `x_migrator`, so it owns what they create and `x_app`, what `x dev` serves as, owns nothing.
 * Off, nothing runs. Returns the undo.
 */
export async function migrateAsMigrator(root: string): Promise<() => Promise<void>> {
  if (!rowSecurityDeclared(await loadAppConfig(root))) return async () => undefined;
  return holdMigratorRole(db());
}
