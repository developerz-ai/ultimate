// The destructive-SQL rail at the gate: an `up` that drops, truncates or retypes must declare it.
// Files, not the database, so the rail fires in CI rather than first in a release phase.
// `@ultimat3/db` owns the classifier `x db gen` wrote the marker from — the generator and the gate
// cannot disagree about one file.

import { destructiveStatements, hasDestructiveMarker, migrationDestructive } from '@ultimat3/db';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { type Finding, findingFrom } from './output';

/**
 * One finding per migration, never one per statement: the marker declares the whole file, so a
 * second finding would repeat the instruction the first already gave. The count still rides along
 * in `cause`, because "and 3 more" is the difference between a typo and a rewrite.
 *
 * `readMigrations` is the reader `x db migrate` applies from, and only its `up` half is judged —
 * a rail checking a list the migrator does not run, or SQL the migrator never sends, enforces
 * nothing. An app with no migrations directory has nothing to declare and reports nothing.
 */
export async function checkDestructiveMigrations(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const migration of await readMigrations(root)) {
    if (hasDestructiveMarker(migration.up)) continue;
    const [first, ...rest] = destructiveStatements(migration.up);
    if (first === undefined) continue;
    const file = `${MIGRATIONS_DIR}/${migration.id}.sql`;
    findings.push({ ...findingFrom(migrationDestructive(file, first, rest.length)), at: file });
  }
  return findings;
}
