// The lock-heavy rail at the gate: a migration newer than the rail that would hold a live table
// still for a full scan must take the two-step form or say the lock is deliberate. Files, not the
// database, so it fires in CI. `@ultimat3/db` owns the classifier, the marker and the bound.

import { lockHeavyJudged, lockHeavyStatements, migrationLockHeavy } from '@ultimat3/db';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { type Finding, findingFrom } from './output';

/**
 * One finding per migration, as `checkDestructiveMigrations`, counting the rest in `cause`. Never a
 * file-wide pass: a `-- lock-heavy: true` line admits only the statement directly under it, and
 * `lockHeavyStatements` already leaves that one out. Only ids past `LOCK_HEAVY_SINCE` are judged,
 * since an applied migration cannot gain a marker.
 */
export async function checkLockHeavyMigrations(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const migration of await readMigrations(root)) {
    if (!lockHeavyJudged(migration.id)) continue;
    const [first, ...rest] = lockHeavyStatements(migration.up);
    if (first === undefined) continue;
    const file = `${MIGRATIONS_DIR}/${migration.id}.sql`;
    findings.push({ ...findingFrom(migrationLockHeavy(file, first, rest.length)), at: file });
  }
  return findings;
}
