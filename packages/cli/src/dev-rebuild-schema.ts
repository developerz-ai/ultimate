// The schema half of an `x dev` generation: entities ahead of the migrations, said when the
// generation is built — at the boot a restart makes, and at a save — instead of first as
// `X_DB_SCHEMA_STALE` on the page that queries the new column.

import { checkSourceDrift } from './drift';
import type { Finding } from './output';
import { findingFrom } from './output';

/** The migrate half too: `x dev` applies no migration, so `x db gen` alone leaves the page red. */
export const SCHEMA_AHEAD_FIX = 'x db gen "describe the change" && x db migrate';

/**
 * `checkSourceDrift`'s answer with the whole instruction. Asked only of a generation that loaded
 * clean: a module that would not import leaves the registry short, which hashes as drift that is not
 * there. Never rejects — a failed check is a finding, never a dev server that will not boot.
 */
export async function schemaAheadFindings(
  root: string,
  check: (root: string) => Promise<readonly Finding[]> = checkSourceDrift,
): Promise<readonly Finding[]> {
  try {
    return (await check(root)).map((finding) => ({
      ...finding,
      cause: `entities are ahead of the migrations: ${finding.cause}`,
      fix: SCHEMA_AHEAD_FIX,
    }));
  } catch (error) {
    return [findingFrom(error)];
  }
}
