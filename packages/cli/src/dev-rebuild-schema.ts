// The schema half of an `x dev` generation: entities ahead of the migrations, said when the
// generation is built — at the boot a restart makes, and at a save — instead of first as
// `X_DB_SCHEMA_STALE` on the page that queries the new column.

import { devCanMigrate } from './dev-db-migrate';
import { checkSourceDrift } from './drift';
import type { Finding } from './output';
import { findingFrom } from './output';
import { resolveServices } from './runtime-bindings';

/**
 * The migrate half too: `x dev` applies no migration unasked, so `x db gen` alone leaves the page
 * red. Beside this process `x db migrate` is applied BY it (`dev-db-migrate.ts`), embedded or not.
 */
export const SCHEMA_AHEAD_FIX = 'x db gen "describe the change" && x db migrate';

/** Where this process cannot apply the pass itself: the embedded database, to the command alone. */
export const SCHEMA_AHEAD_FIX_ALONE =
  'x db gen "describe the change" && x stop --json && x db migrate && x dev';

/** Whether `x db migrate` works while this `x dev` runs: any external database, or a pass it takes. */
export async function migratesBesideDev(root: string): Promise<boolean> {
  return resolveServices(root, Bun.env).db.mode !== 'embedded' || (await devCanMigrate(root));
}

/**
 * `checkSourceDrift`'s answer with the whole instruction. Asked only of a generation that loaded
 * clean: a module that would not import leaves the registry short, which hashes as drift that is not
 * there. Never rejects — a failed check is a finding, never a dev server that will not boot.
 */
export async function schemaAheadFindings(
  root: string,
  check: (root: string) => Promise<readonly Finding[]> = checkSourceDrift,
  beside: (root: string) => Promise<boolean> = migratesBesideDev,
): Promise<readonly Finding[]> {
  try {
    const drifted = await check(root);
    if (drifted.length === 0) return [];
    const fix = (await beside(root)) ? SCHEMA_AHEAD_FIX : SCHEMA_AHEAD_FIX_ALONE;
    return drifted.map((finding) => ({
      ...finding,
      cause: `entities are ahead of the migrations: ${finding.cause}`,
      fix,
    }));
  } catch (error) {
    return [findingFrom(error)];
  }
}
