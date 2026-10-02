// The schema dump, regenerated on behalf of a command: `x db gen` and `x db migrate` both end by
// making `packages/db/schema/` equal to what the migrations produce. Split from
// `db-schema-dump.ts`, which replays and writes; this decides what a command REPORTS when the dump
// was written, was already right, was not owed, or could not be produced — and holds the two
// findings that are about the dump as a whole rather than about one file in it.

import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import type { Migration } from '@ultimat3/db';
import { PGLITE_MISSING } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import {
  hasSchemaDump,
  type ReplayedSchema,
  replayFor,
  SCHEMA_DUMP_DIR,
  type SchemaDumpWrite,
  writeSchemaDump,
} from './db-schema-dump';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { Finding, JsonValue } from './output';
import { findingFrom, isUltimateErrorShape } from './output';

/**
 * The migrations would not replay, so there is no dump to write and nothing to compare one with.
 * A framework error keeps its own cause; the fix is replaced, because the engine's own (`set
 * DATABASE_URL …`) answers a question nobody asked — this database is a scratch one booted here.
 *
 * Two causes are not about the migrations at all, and each keeps the fix that repairs it: a
 * refusal this pipeline raised itself (`X_SCHEMA_DUMP_DRIFT` — no server for an extension the
 * embedded database cannot link) arrives whole, and a missing optional peer gets the install,
 * because `x db migrate` would succeed and teach nothing.
 */
export function replayFailure(error: unknown): Finding {
  if (isUltimateErrorShape(error) && error.code === 'X_SCHEMA_DUMP_DRIFT') {
    return { ...findingFrom(error), docs: ERROR_DOCS_URL, at: MIGRATIONS_DIR };
  }
  const detail = isUltimateErrorShape(error) ? findingFrom(error).cause : renderThrowable(error);
  const missing = detail.startsWith(PGLITE_MISSING);
  return {
    code: 'X_SCHEMA_DUMP_DRIFT',
    cause: missing
      ? `the schema dump is replayed on the embedded database and ${detail}`
      : `the migrations do not replay on the scratch database, so the schema dump cannot be produced: ${detail}`,
    fix: missing
      ? // A literal, as `@ultimat3/db`'s own `PGLITE_FIX` is: a `fix:` splices nothing into its
        // command position, and `db-schema-refresh.test.ts` holds it equal to `PGLITE_PACKAGE`.
        'bun add -d @electric-sql/pglite   # then: x db gen'
      : 'x db migrate --json   # applies the same migrations to the dev database; a statement refused there too is the one to repair — then: x db gen',
    docs: ERROR_DOCS_URL,
    at: missing ? SCHEMA_DUMP_DIR : MIGRATIONS_DIR,
  };
}

/**
 * The same finding, for a run of `x db gen` that DID write its migration before the dump failed.
 * The exit code is 1 and the migration is on disk, and a reader who sees only the first fact
 * generates a second migration for a schema that is already recorded. So the cause leads with
 * the file that exists, and says what the next `x db gen` will and will not do.
 */
export const afterWrittenMigration = (finding: Finding, id: string): Finding => ({
  ...finding,
  cause: `migration ${id} WAS written to ${MIGRATIONS_DIR} and is not to be generated again; only the schema dump failed, and once that is repaired a bare x db gen writes the dump and no second migration — ${finding.cause}`,
});

/** An app with a migration and no dump directory: one finding, and no database booted to say so. */
export const dumpNeverGenerated = (): Finding => ({
  code: 'X_SCHEMA_DUMP_DRIFT',
  cause: `${MIGRATIONS_DIR} holds migrations and ${SCHEMA_DUMP_DIR} does not exist: the schema dump was never generated`,
  fix: 'x db gen',
  docs: ERROR_DOCS_URL,
  at: SCHEMA_DUMP_DIR,
});

export interface SchemaDumpRefresh extends SchemaDumpWrite {
  /**
   * `skipped` — no migration and no dump, so nothing is owed and no database is booted.
   * `failed` — the migrations did not replay; `finding` says why, and the dump on disk is left
   * exactly as it was.
   */
  readonly status: 'written' | 'unchanged' | 'skipped' | 'failed';
  readonly finding?: Finding | undefined;
  /** The replayed catalog, for a caller that compares a live database against it. */
  readonly catalog?: CatalogDescription | undefined;
}

const NOTHING: SchemaDumpWrite = { written: [], removed: [], total: 0 };

/**
 * Regenerate the dump after `x db gen` or `x db migrate`. Never throws: a replay that fails is
 * reported as the finding it is, after the migration the command was asked for is already written.
 */
export async function refreshSchemaDump(
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  // Injected so the reporting rules are testable without booting a database per case.
  replay: (migrations: readonly Migration[]) => Promise<ReplayedSchema> = replayFor(
    root,
    env,
    false,
  ),
): Promise<SchemaDumpRefresh> {
  const migrations = await readMigrations(root);
  if (migrations.length === 0 && !hasSchemaDump(root)) return { ...NOTHING, status: 'skipped' };
  let replayed: ReplayedSchema;
  try {
    replayed = await replay(migrations);
  } catch (error) {
    return { ...NOTHING, status: 'failed', finding: replayFailure(error) };
  }
  const write = await writeSchemaDump(root, replayed.files);
  const changed = write.written.length + write.removed.length > 0;
  return { ...write, status: changed ? 'written' : 'unchanged', catalog: replayed.catalog };
}

/** The `--json` shape both commands report under `data.schemaDump`. */
export const schemaDumpJson = (refresh: SchemaDumpRefresh): JsonValue => ({
  directory: SCHEMA_DUMP_DIR,
  status: refresh.status,
  files: refresh.total,
  written: [...refresh.written],
  removed: [...refresh.removed],
});
