// Single responsibility: whether the `drift` step has a SQL schema to judge. Migrations, drift and
// `x db` describe Postgres only; an app whose rows live in a `defineDriver` store owns its schema,
// and the step skips it with the reason printed rather than demanding `x db gen "initial"`.

import type { DriverStoreKind } from '@ultimat3/entity/adapter';
import { driverStores } from '@ultimat3/entity/adapter';
import { msg } from './messages';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';
import { fromFindings, type StepOutcome } from './verify-step';

type Stores = () => Readonly<Record<DriverStoreKind, readonly string[]>>;

/** A recorded migration is proof of a SQL schema, whatever the loaded modules constructed. */
const hasMigration = (root: string): boolean => {
  // Scanned from the app root, which exists, so a missing migrations directory is no match.
  for (const _ of new Bun.Glob(`${MIGRATIONS_DIR}/*.hash`).scanSync({ cwd: root })) return true;
  return false;
};

/**
 * The reason to skip, or `undefined` to run. Read AFTER the app is loaded — the drivers its
 * modules construct are what `driverStores()` records. Skips only when every noted store is a
 * custom one AND no migration exists: a mixed app has migrations for its Postgres tables, so a
 * Postgres driver that has not noted itself still cannot switch the step off.
 */
export const nonSqlDriftSkip = (
  root: string,
  stores: Stores = driverStores,
): string | undefined => {
  const { sql, custom } = stores();
  if (custom.length === 0 || sql.length > 0 || hasMigration(root)) return undefined;
  return msg('cli.verify.driftNonSql', { stores: custom.join(', ') });
};

export interface DriftRails {
  /** The migration and schema rails — the ones a store owning its own schema has nothing for. */
  readonly schema: () => Promise<readonly Finding[]>;
  /** The generated client against its stamp: a fact about the app's API, whatever stores rows. */
  readonly client: () => Promise<readonly Finding[]>;
  readonly stores?: Stores;
}

/**
 * The `drift` step's outcome. A non-SQL app skips the schema rails, with the reason in `output`,
 * and still runs the client rail — a stale `x client` is drift whatever the store is.
 */
export const driftOutcome = async (root: string, rails: DriftRails): Promise<StepOutcome> => {
  const skipped = nonSqlDriftSkip(root, rails.stores);
  const findings = [
    ...(skipped === undefined ? await rails.schema() : []),
    ...(await rails.client()),
  ];
  return { ...fromFindings(findings), ...(skipped === undefined ? {} : { output: skipped }) };
};
