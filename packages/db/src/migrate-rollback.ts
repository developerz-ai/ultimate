// Single responsibility: recognise a ledger an OLDER build is being rolled back onto — rows the
// newer build applied, every one of them newer than anything this build ships — and decide whether
// the migrate role lets that rollback through: yes over additive rows, no over destructive ones.

import { renderFixShellArg } from '@ultimat3/core';
import { isDestructiveMigration } from './destructive';
import { DbError } from './errors';
import type { LedgerRow, Migration } from './migration-ledger';
import { pendingMigrations } from './migration-ledger';

/** The operator's written override: the destructive migration ids they checked, comma-separated. */
export const ROLLBACK_ALLOW_DESTRUCTIVE_ENV = 'ROLLBACK_ALLOW_DESTRUCTIVE';

/** A rollback: the rows this build does not know (all newer), and the ledger it does. */
export interface LedgerAhead {
  /** The rows a newer build applied, oldest first. Never empty. */
  readonly ahead: readonly LedgerRow[];
  /** Every other row — the part this build's own audit still runs over. */
  readonly known: readonly LedgerRow[];
}

export interface LedgerAheadOptions {
  /** `ROLLBACK_ALLOW_DESTRUCTIVE`'s value; read from the environment when not given. */
  readonly allow?: string | undefined;
}

/** What the ledger records at apply: whether this migration's `up` destroys data. */
export const destructiveBit = (migration: Migration): boolean =>
  isDestructiveMigration(migration.up);

/**
 * The ledger split, when it is exactly a rollback, else `undefined` and the caller's audit refuses
 * the unknown rows as it always has. Three conditions, all required:
 *
 * - every row this build does not ship sorts AFTER the newest migration it does ship — the ids are
 *   `<stamp>_<name>`, the order `pendingMigrations` applies them in. One unknown row between two
 *   shipped ones is a deleted or renamed migration, not a newer build's work;
 * - this build has nothing left to apply. A pending migration beside newer rows means the database
 *   never held this build's schema: two branches, not a rollback;
 * - the build ships at least one migration. An image that lost its migrations directory is not
 *   "older than every row", and reading it as one would wave through the image that is broken.
 *
 * Nothing is applied either way. Over ADDITIVE rows the older build runs on the newer schema
 * (expand/contract, docs/ops/06-runbooks.md). Over a row the newer build recorded as destructive
 * it may not — a dropped column it still selects is the second outage — so that rollback is
 * refused (`X_MIGRATION_ROLLBACK_DESTRUCTIVE`) unless the operator named every such row.
 */
export function ledgerAheadOfBuild(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
  options: LedgerAheadOptions = {},
): LedgerAhead | undefined {
  if (migrations.length === 0) return undefined;
  const shipped = new Set(migrations.map((migration) => migration.id));
  const newest = [...shipped].sort().at(-1) ?? '';
  const unknown = ledger.filter((row) => !shipped.has(row.id));
  if (unknown.length === 0 || unknown.some((row) => row.id <= newest)) return undefined;
  const known = ledger.filter((row) => shipped.has(row.id));
  if (pendingMigrations(known, migrations).length > 0) return undefined;
  const ahead = [...unknown].sort((a, b) => (a.id < b.id ? -1 : 1));
  assertRollbackSafe(ahead, options.allow ?? Bun.env[ROLLBACK_ALLOW_DESTRUCTIVE_ENV]);
  return { ahead, known };
}

/** Every destructive row ahead must be named by the override; a null bit is not refused. */
function assertRollbackSafe(ahead: readonly LedgerRow[], allow: string | undefined): void {
  const named = new Set(
    (allow ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );
  const refused = ahead.filter((row) => row.destructive === true && !named.has(row.id));
  if (refused.length === 0) return;
  const ids = refused.map((row) => row.id);
  const all = ahead.filter((row) => row.destructive === true).map((row) => row.id);
  throw new DbError({
    code: 'X_MIGRATION_ROLLBACK_DESTRUCTIVE',
    cause: `the ledger holds ${ids.length} destructive migration(s) a newer build applied (${ids.join(', ')}) and this build predates them — it may read a column or table that no longer exists`,
    fix: `x deploy --image <the newer image> --json   # roll forward; or, after checking this build runs on the newer schema: ${ROLLBACK_ALLOW_DESTRUCTIVE_ENV}=${renderFixShellArg(all.join(','), '<migration id>')} on the migrate role`,
    meta: { refused: ids, appVersions: [...new Set(refused.map((row) => row.app_version))] },
  });
}
