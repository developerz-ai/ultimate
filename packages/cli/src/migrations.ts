// The app's SQL migrations, read off disk into `@ultimat3/db`'s own `Migration` shape. One reader,
// because the release phase and the developer must apply the identical list through the identical
// ledger — a deploy that migrated by some other route is a schema nobody can reconstruct.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration, SchemaDescription } from '@ultimat3/db';
import { parseSnapshot } from '@ultimat3/db';

/** Where `x new` writes them and where `x db gen` adds to. App-root-relative, POSIX. */
export const MIGRATIONS_DIR = 'packages/db/migrations';

/** The schema `<id>` leaves behind, written by `x db gen` so the next one can diff against it. */
export const snapshotFileName = (id: string): string => `${id}.snapshot.json`;

/** The hash of the entity source `<id>` was generated from. `drift.ts` writes and reads it. */
export const hashFileName = (id: string): string => `${id}.hash`;

/**
 * `-- down` alone on a line splits a migration file. Anchored to the whole line so a comment that
 * merely mentions the word — `-- down migrations are required` — is not mistaken for the marker.
 */
const DOWN_MARKER = /^[ \t]*--[ \t]*down[ \t]*$/im;

/** `0000_initial` → the ledger id; `initial` → the name a conflict message prints. */
export const migrationName = (id: string): string => id.replace(/^\d+_/, '');

export function parseMigrationSql(id: string, sql: string): Migration {
  const marker = DOWN_MARKER.exec(sql);
  const up = (marker === null ? sql : sql.slice(0, marker.index)).trim();
  const down = marker === null ? '' : sql.slice(marker.index + marker[0].length).trim();
  return { id, name: migrationName(id), up, down };
}

/**
 * A snapshot that will not parse is *absent*, never a half-read one: the `up` beside it is still
 * the migration this app applies, so the file list stays whole. What that absence then means is
 * the caller's — `x db gen` refuses with `X_MIGRATION_SNAPSHOT_MISSING` when it is the newest
 * migration's, because there is nothing left to diff the entities against.
 */
async function readSnapshot(dir: string, id: string): Promise<SchemaDescription | undefined> {
  const file = Bun.file(join(dir, snapshotFileName(id)));
  if (!(await file.exists())) return undefined;
  // Parsed to the last nested field by `@ultimat3/db`, never asserted: `{"tables":[null]}` is
  // valid JSON and a cast made it a `SchemaDescription` the diff then threw on.
  return parseSnapshot(await file.json().catch(() => undefined));
}

/**
 * Sorted by id, because that is the apply order and `pendingMigrations` re-sorts on the same key.
 * A missing directory is an empty list rather than a throw: an app can legitimately declare no
 * entity yet, and the count is reported so "nothing was applied" is never silent.
 *
 * `<id>.down.sql` is skipped and never read as a migration of its own. Migrations before 1.2.0
 * were hand-written as a `<id>.sql` / `<id>.down.sql` pair — a layout no generator ever produced
 * and this reader would have applied as a migration named `<id>.down`, dropping every table the
 * pair exists to reverse. One migration is one file, split by the `-- down` marker.
 */
export async function readMigrations(root: string): Promise<readonly Migration[]> {
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for await (const file of new Bun.Glob('*.sql').scan({ cwd: dir })) {
    if (!file.endsWith('.down.sql')) files.push(file);
  }
  files.sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const text = await Bun.file(join(dir, file)).text();
    const snapshot = await readSnapshot(dir, id);
    migrations.push({
      ...parseMigrationSql(id, text),
      ...(snapshot === undefined ? {} : { snapshot }),
    });
  }
  return migrations;
}
