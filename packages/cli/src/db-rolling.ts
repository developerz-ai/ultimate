// The rolling-deploy rail at the gate: an `up` old pods would trip over must have retired first, or
// say it stops before it starts. Files, not the database, so it fires in CI. `@ultimat3/db` owns the
// classifier and the markers; this file owns the walk and the bound an app sets in `x.verify.json`.

import {
  hasRollingUnsafeMarker,
  migrationRollingUnsafe,
  retiredColumnsIn,
  rollingUnsafeStatements,
  unretiredColumnsIn,
} from '@ultimat3/db';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { type Finding, findingFrom } from './output';
import { readVerifyFloor } from './verify-floor';

/**
 * Unset is silent and that is the promise: an applied migration cannot gain a marker (checksum), so
 * an existing app could only ever clear this by rewriting history. `x doctor` reminds it instead.
 *
 * Every migration is walked for its retires, the bounded ones too: a retire shipped before the bound
 * still earns the drop after it, and one taken back earns nothing. One finding per migration, as
 * `checkDestructiveMigrations`.
 */
export async function checkRollingMigrations(root: string): Promise<readonly Finding[]> {
  const since = (await readVerifyFloor(root))?.rollingSince;
  if (since === undefined) return [];
  const findings: Finding[] = [];
  const retired = new Set<string>();
  for (const migration of await readMigrations(root)) {
    if (migration.id > since && !hasRollingUnsafeMarker(migration.up)) {
      const [first, ...rest] = rollingUnsafeStatements(migration.up, retired);
      if (first !== undefined) {
        const file = `${MIGRATIONS_DIR}/${migration.id}.sql`;
        findings.push({
          ...findingFrom(migrationRollingUnsafe(file, first, rest.length)),
          at: file,
        });
      }
    }
    // After the judging: a retire in the same file lands in the same deploy, so it is not earlier.
    for (const key of retiredColumnsIn(migration.up)) retired.add(key);
    for (const key of unretiredColumnsIn(migration.up)) retired.delete(key);
  }
  return findings;
}
