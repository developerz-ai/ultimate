// Single responsibility: what `x db gen` and the gate's `drift` step read about row security — the
// app's `database.rowSecurity` and each tenant table's column — and the drift step's verdict on it.
// One reader for both, so the gate can never expect a policy the generator would not write.

import type { EntityDescriptionLike, RowSecurityOption, SchemaDescription } from '@ultimat3/db';
import { rowSecurityDifferences, rowSecurityDrift } from '@ultimat3/db';
import { describeTenancy } from '@ultimat3/entity';
import { loadAppConfig } from './app-config-load';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';
import { rowSecurityDeclared } from './row-security-boot';

/** The app's answer, read after `loadApp` filled the registry. Injected for tests. */
export type RowSecurityWanted = (root: string) => Promise<RowSecurityOption>;

export const appRowSecurity: RowSecurityWanted = async (root) => ({
  enabled: rowSecurityDeclared(await loadAppConfig(root)),
  tenants: describeTenancy(),
});

/** One `X_DB_ROW_SECURITY_DRIFT` per tenant table the flag and the newest snapshot disagree on. */
export function rowSecurityFindings(
  entities: readonly EntityDescriptionLike[],
  recorded: SchemaDescription,
  option: RowSecurityOption,
): readonly Finding[] {
  return rowSecurityDifferences(entities, recorded, option).map((difference) => ({
    ...findingFrom(rowSecurityDrift(difference)),
    at: MIGRATIONS_DIR,
  }));
}
