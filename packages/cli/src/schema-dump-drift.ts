// The `drift` step's fourth rail: is the committed schema dump what the migrations produce, and
// does a database loaded from it come back the same? The other three rails read files and open
// nothing; this one replays the migrations on a scratch embedded database, because "what the
// migrations produce" is a fact only a database can state.

// why: Bun has no directory probe — `Bun.file().exists()` answers about a file.
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Migration } from '@ultimat3/db';
import type { SchemaDumpDifference } from '@ultimat3/db/schema-dump';
import { compareSchemaDump, schemaDumpDrift } from '@ultimat3/db/schema-dump';
import {
  hasSchemaDump,
  type ReplayedSchema,
  readSchemaDump,
  replayFor,
  SCHEMA_DUMP_DIR,
} from './db-schema-dump';
import { dumpNeverGenerated, replayFailure } from './db-schema-refresh';
import { DB_PACKAGE } from './drift';
import { readMigrations } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';

/** Injected so this module's rules are testable without booting a database per case. */
export type SchemaReplay = (migrations: readonly Migration[]) => Promise<ReplayedSchema>;

const findingFor = (difference: SchemaDumpDifference): Finding => ({
  ...findingFrom(schemaDumpDrift(difference)),
  docs: ERROR_DOCS_URL,
  at: `${SCHEMA_DUMP_DIR}/${difference.path}`,
});

/**
 * Empty result = the dump is the migrations' own.
 *
 * An app with no migration and no dump owes none — zero recorded against zero dumped is agreement,
 * the rule `checkSourceDrift` states for entities, and what keeps `x new --no-example` green. From
 * the first migration on the dump is owed: a missing directory is one finding naming the command
 * that writes it, reported without booting a database.
 *
 * Both halves are reported together. A stale file and a dump that does not round-trip are two
 * repairs, and hiding the second behind the first hands out `x db gen` for a dump regenerating
 * cannot fix.
 */
export async function checkSchemaDump(
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  replay: SchemaReplay = replayFor(root, env, true),
): Promise<readonly Finding[]> {
  if (!existsSync(join(root, DB_PACKAGE))) return [];
  const migrations = await readMigrations(root);
  if (!hasSchemaDump(root)) return migrations.length === 0 ? [] : [dumpNeverGenerated()];
  const committed = await readSchemaDump(root);
  let replayed: ReplayedSchema;
  try {
    replayed = await replay(migrations);
  } catch (error) {
    return [replayFailure(error)];
  }
  return [...compareSchemaDump(committed, replayed.files), ...replayed.reload].map(findingFor);
}
