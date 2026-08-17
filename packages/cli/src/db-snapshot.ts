// `x db gen`'s own precondition, asked as a diagnostic rather than met as a throw: a newest
// migration with no `.snapshot.json` leaves the next generation nothing to diff against, so it
// refuses before writing anything. `@ultimat3/db` owns both the condition (`declaredSchema`) and
// the wording, so this check and that refusal cannot disagree about one directory.

import { declaredSchema, migrationSnapshotMissing } from '@ultimat3/db';
import { MIGRATIONS_DIR, readMigrations, snapshotFileName } from './migrations';
import { type Finding, findingFrom } from './output';

/**
 * Empty result = the next `x db gen` has something to start from. An app with no migrations at all
 * reports nothing: `declaredSchema([])` is the empty schema, which is a real answer and the state a
 * freshly scaffolded app is in before its first generation.
 *
 * One finding, never one per file. Only the NEWEST snapshot is what a diff starts from, so an older
 * migration missing one is a fact about history and not something the author can act on.
 */
export async function checkMigrationSnapshots(root: string): Promise<readonly Finding[]> {
  const migrations = await readMigrations(root);
  if (declaredSchema(migrations) !== undefined) return [];
  const id = migrations[migrations.length - 1]?.id ?? '';
  const file = `${MIGRATIONS_DIR}/${snapshotFileName(id)}`;
  return [{ ...findingFrom(migrationSnapshotMissing(id, file)), at: file }];
}
