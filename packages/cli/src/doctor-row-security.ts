// Single responsibility: `x doctor`'s row-security question, asked without booting — with
// `database.rowSecurity` on, is the role `DATABASE_URL` connects as one Postgres applies policies
// to. The boot refuses the same role (`X_DB_ROW_SECURITY_BYPASSED`); this says so before a deploy.

import { resolveRole } from '@ultimat3/core';
import { assertRowSecurityBinds, DbError, postgresClient } from '@ultimat3/db';
import { loadAppConfig } from './app-config-load';
import type { Finding } from './output';
import { findingFrom } from './output';
import { rowSecurityDeclared } from './row-security-boot';

/**
 * External databases only: an embedded one serves as `x_app` by construction (`serveAsAppRole`).
 * An unreachable server is `database()`'s finding to make, so only the exemption is reported here.
 * The flag-against-migrations half is `X_DB_ROW_SECURITY_DRIFT`, reported by the drift probe.
 */
export async function rowSecurityProbe(
  root: string,
  url: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly Finding[]> {
  if (url === undefined || url.trim() === '') return [];
  if (!rowSecurityDeclared(await loadAppConfig(root))) return [];
  const client = postgresClient({
    url,
    role: resolveRole({ env }),
    env,
    applicationName: 'x-doctor',
  });
  try {
    await assertRowSecurityBinds(client);
    return [];
  } catch (error) {
    return error instanceof DbError && error.code === 'X_DB_ROW_SECURITY_BYPASSED'
      ? [findingFrom(error)]
      : [];
  } finally {
    await client.close();
  }
}
