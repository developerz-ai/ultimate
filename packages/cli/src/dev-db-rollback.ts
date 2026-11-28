// The two other things `x db` asks of a live `x dev` that holds the embedded database, beside the
// migrate pass: reverse applied migrations (`x db rollback`), and read the ledger's checksums
// (`x db gen`'s edited-migration check). Bodies only — `dev-db-migrate.ts` mounts and guards them.

import { db, isLedgerMissing, readLedger } from '@ultimat3/db';
import { ROLLBACK_STEPS } from './db-dev-wire';
import { reverseApplied } from './db-rollback-pass';
import { devMigratorPass } from './dev-db-migrator-hold';
import { parseIntFlag } from './flag-number';

type Env = Readonly<Record<string, string | undefined>>;

/** `?steps=n`, through the command's own reader: the door refuses what the flag refuses. */
export const stepsOf = (raw: string | null): number => parseIntFlag(raw ?? '', ROLLBACK_STEPS);

/**
 * `rollback()` over the client this process already holds, with the command's own two refusals.
 * Where it serves as `x_app`, the reversal runs as `x_migrator` under the same hold a migrate
 * pass takes (`dev-db-migrator-hold.ts`).
 */
export async function rollbackInDev(
  root: string,
  env: Env,
  steps: number,
): Promise<{ readonly reverted: readonly string[] }> {
  return {
    reverted: await devMigratorPass(root, env, ({ client, lock }) =>
      reverseApplied(root, env, steps, { client, lock }),
    ),
  };
}

/** Each applied migration's id and the checksum it was applied with; no ledger is no rows. */
export async function ledgerInDev(): Promise<{
  readonly ledger: readonly { readonly id: string; readonly checksum: string }[];
}> {
  const rows = await readLedger(db()).catch((error: unknown) => {
    if (!isLedgerMissing(error)) throw error;
    return [];
  });
  return { ledger: rows.map((row) => ({ id: row.id, checksum: row.checksum })) };
}
