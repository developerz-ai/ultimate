// The schema half of an `x dev` generation: entities ahead of the migrations, and migrations ahead
// of the database's ledger, said when the generation is built — at the boot a restart makes, and
// at a save — instead of first as `X_DB_SCHEMA_STALE` on the page that queries the new column.

import type { Migration } from '@ultimat3/db';
import { db, dbClientInstalled, isLedgerMissing, readLedger } from '@ultimat3/db';
import { AppMigrationsUnappliedError } from './app-migrations-verdict';
import { type AppliedRow, refuseEdited } from './db-applied-edits';
import { checkSourceDrift } from './drift';
import { readMigrations } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';

/**
 * The migrate half too: `x dev` applies no migration unasked, so `x db gen` alone leaves the page
 * red. Beside this process `x db migrate` is applied BY it (`dev-db-migrate.ts`), embedded or not,
 * and with `database.rowSecurity` as `x_migrator` under a hold (`dev-db-migrator-hold.ts`).
 */
export const SCHEMA_AHEAD_FIX = 'x db gen "describe the change" && x db migrate';

/** What `ledgerFindings` asks — the seam a test hands rows through. */
export interface LedgerReads {
  readonly migrations: (root: string) => Promise<readonly Migration[]>;
  /**
   * Whether this process holds a database at all. `x dev`'s boot installs its client before the
   * first generation; a caller that built one with none (a test, a tool) has nothing to compare
   * against, and `db()` would dial a default for it.
   */
  readonly database: () => boolean;
  /** `undefined` when the ledger table does not exist: nothing was ever applied. */
  readonly ledger: () => Promise<readonly AppliedRow[] | undefined>;
}

const READS: LedgerReads = {
  migrations: readMigrations,
  database: dbClientInstalled,
  ledger: async () => {
    try {
      return await readLedger(db());
    } catch (error) {
      if (!isLedgerMissing(error)) throw error;
      return undefined;
    }
  },
};

/**
 * The migrations on disk against the ledger of the database this process serves. `x db gen` beside
 * a running `x dev` writes a file the database has not applied: every read of the new column is a
 * 500, so the generation is not green until `x db migrate` — which this process applies itself
 * (`dev-db-migrate.ts`) and then rebuilds for (`dev-db-settled.ts`). An applied migration edited
 * since is the other half of the same read: `X_MIGRATION_CONFLICT`, as the migrator would refuse.
 */
export async function ledgerFindings(
  root: string,
  reads: LedgerReads = READS,
): Promise<readonly Finding[]> {
  const migrations = await reads.migrations(root);
  if (migrations.length === 0 || !reads.database()) return [];
  const ledger = await reads.ledger();
  const applied = new Set((ledger ?? []).map((row) => row.id));
  const missing = migrations.map((migration) => migration.id).filter((id) => !applied.has(id));
  const findings: Finding[] = [];
  if (missing.length > 0) {
    findings.push(
      findingFrom(new AppMigrationsUnappliedError({ missing, ledger: ledger !== undefined })),
    );
  }
  try {
    refuseEdited(ledger ?? [], migrations);
  } catch (error) {
    findings.push(findingFrom(error));
  }
  return findings;
}

/** Every finding this module handed a generation — by identity, since any code may be one. */
const schemaFindings = new WeakSet<Finding>();

/**
 * Whether `finding` is about the schema, not about what this process loaded or mounted. A schema
 * finding appearing or clearing never needs a new process (`dev-rebuild.ts`): the modules and the
 * route table are the same, and this process is the one that applies the migration.
 */
export const isSchemaFinding = (finding: Finding): boolean => schemaFindings.has(finding);

function marked(findings: readonly Finding[]): readonly Finding[] {
  for (const finding of findings) schemaFindings.add(finding);
  return findings;
}

/**
 * `checkSourceDrift`'s answer with the whole instruction, then the ledger's. Asked only of a
 * generation that loaded clean: a module that would not import leaves the registry short, which
 * hashes as drift that is not there. Never rejects — a failed check is a finding, never a dev
 * server that will not boot.
 */
export async function schemaAheadFindings(
  root: string,
  check: (root: string) => Promise<readonly Finding[]> = checkSourceDrift,
  ledger: (root: string) => Promise<readonly Finding[]> = ledgerFindings,
): Promise<readonly Finding[]> {
  try {
    const drifted = await check(root);
    return marked([
      ...drifted.map((finding) => ({
        ...finding,
        cause: `entities are ahead of the migrations: ${finding.cause}`,
        fix: SCHEMA_AHEAD_FIX,
      })),
      ...(await ledger(root)),
    ]);
  } catch (error) {
    return marked([findingFrom(error)]);
  }
}
