// The app's SQL migrations, read off disk into `@ultimat3/db`'s own `Migration` shape. One reader,
// because the release phase and the developer must apply the identical list through the identical
// ledger — a deploy that migrated by some other route is a schema nobody can reconstruct.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration } from '@ultimat3/db';

/** Where `x new` writes them and where `x db gen` adds to. App-root-relative, POSIX. */
export const MIGRATIONS_DIR = 'packages/db/migrations';

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
 * Sorted by id, because that is the apply order and `pendingMigrations` re-sorts on the same key.
 * A missing directory is an empty list rather than a throw: an app can legitimately declare no
 * entity yet, and the count is reported so "nothing was applied" is never silent.
 */
export async function readMigrations(root: string): Promise<readonly Migration[]> {
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for await (const file of new Bun.Glob('*.sql').scan({ cwd: dir })) files.push(file);
  files.sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const text = await Bun.file(join(dir, file)).text();
    migrations.push(parseMigrationSql(file.replace(/\.sql$/, ''), text));
  }
  return migrations;
}
