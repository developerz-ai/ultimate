// Single responsibility: recognise a ledger an OLDER build is being rolled back onto — rows the
// newer build applied, every one of them newer than anything this build ships — so the migrate
// role lets a rollback through instead of failing the deploy that is trying to undo a bad one.

import type { LedgerRow, Migration } from './migration-ledger';
import { pendingMigrations } from './migration-ledger';

/** A rollback: the rows this build does not know (all newer), and the ledger it does. */
export interface LedgerAhead {
  /** The rows a newer build applied, oldest first. Never empty. */
  readonly ahead: readonly LedgerRow[];
  /** Every other row — the part this build's own audit still runs over. */
  readonly known: readonly LedgerRow[];
}

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
 * Nothing is applied either way: the schema the newer build left is additive over this one when
 * the release followed expand/contract (docs/ops/06-runbooks.md), and when it did not, no
 * migration this build ships could put it back.
 */
export function ledgerAheadOfBuild(
  ledger: readonly LedgerRow[],
  migrations: readonly Migration[],
): LedgerAhead | undefined {
  if (migrations.length === 0) return undefined;
  const shipped = new Set(migrations.map((migration) => migration.id));
  const newest = [...shipped].sort().at(-1) ?? '';
  const unknown = ledger.filter((row) => !shipped.has(row.id));
  if (unknown.length === 0 || unknown.some((row) => row.id <= newest)) return undefined;
  const known = ledger.filter((row) => shipped.has(row.id));
  if (pendingMigrations(known, migrations).length > 0) return undefined;
  return { ahead: [...unknown].sort((a, b) => (a.id < b.id ? -1 : 1)), known };
}
