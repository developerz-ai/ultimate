// Source drift: the app's schema *source* against what migrations recorded. `x db gen` writes the
// hash of the entity schema next to the migration it produced, so drift here is "the schema hashes
// to something no migration recorded". The hash is committed beside the migration, so a fresh clone
// answers with no local state and CI needs no database. An app with NO migration at all is the one
// case that also asks how many entities are declared — see `checkSourceDrift`.
//
// This is not the post-migrate verification and deliberately cannot be: that one is the live
// database against the ledger (`checkDrift`, `@ultimat3/db`), asked by `runMigrations` where a
// connection is open. Same `X_DB_DRIFT`, two conditions — an entity edited with no migration
// generated, versus a database that does not match the migrations it ran.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { countDeclaredEntities } from './app-entities';
// One declaration of where migrations live, and it belongs to the module that reads them —
// `x db migrate` and this sidecar must never disagree about the directory they share.
import { hashFileName, MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';

export const DB_PACKAGE = join('packages', 'db');
const SCHEMA_GLOB = 'packages/db/src/**/*.ts';

/** Content hash of the whole schema, order-independent per file path. */
export async function schemaHash(root: string): Promise<string> {
  const glob = new Bun.Glob(SCHEMA_GLOB);
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: root, absolute: false })) {
    if (!path.includes('.test.')) paths.push(path);
  }
  paths.sort();
  const hasher = new Bun.CryptoHasher('sha256');
  for (const path of paths) {
    hasher.update(path);
    hasher.update(await Bun.file(join(root, path)).text());
  }
  return hasher.digest('hex').slice(0, 16);
}

export interface MigrationRecord {
  readonly file: string;
  readonly hash: string;
}

/** Every `<n>_<name>.hash` sidecar, sorted by filename so the last entry is the newest. */
export async function recordedHashes(root: string): Promise<readonly MigrationRecord[]> {
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  const glob = new Bun.Glob('*.hash');
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: dir, absolute: false })) files.push(file);
  files.sort();
  const out: MigrationRecord[] = [];
  for (const file of files) {
    out.push({ file, hash: (await Bun.file(join(dir, file)).text()).trim() });
  }
  return out;
}

export async function writeSchemaHash(root: string, migrationId: string): Promise<string> {
  const hash = await schemaHash(root);
  await Bun.write(join(root, MIGRATIONS_DIR, hashFileName(migrationId)), `${hash}\n`);
  return hash;
}

/**
 * How many entities the app declares. Injected so this module's own tests need no app on disk, and
 * so a caller that has already loaded the app can answer without loading it twice.
 */
export type DeclaredEntityCount = () => Promise<number>;

/**
 * Empty result = no drift. A missing db package is not drift (an app may have no database yet);
 * a schema with no migration at all is — *provided* the app declares an entity for one to record.
 *
 * The entity count is read lazily and ONLY in that first branch, so an app past its first migration
 * pays nothing for it: every other path answers from file hashes alone, with no app load and no
 * database, which is what lets the gate run this in a CI with neither.
 */
export async function checkSourceDrift(
  root: string,
  declaredEntities: DeclaredEntityCount = () => countDeclaredEntities(root),
): Promise<readonly Finding[]> {
  if (!existsSync(join(root, DB_PACKAGE))) return [];
  const current = await schemaHash(root);
  const records = await recordedHashes(root);
  const latest = records.at(-1);
  if (latest === undefined) {
    // Zero declared against zero recorded is AGREEMENT, not drift. The weaker condition this used
    // to test — "a packages/db directory exists" — held `x new --no-example` permanently red behind
    // `x db gen "initial"`, which has an empty diff there, writes no `.hash`, and exits ok: a fix
    // that succeeds and changes nothing. Drift resumes the moment the author declares an entity,
    // and by then the fix genuinely writes one.
    if ((await declaredEntities()) === 0) return [];
    return [
      {
        code: 'X_DB_DRIFT',
        cause: 'packages/db has a schema but no migration recorded it',
        fix: 'x db gen "initial"',
        docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
        at: MIGRATIONS_DIR,
      },
    ];
  }
  if (records.some((record) => record.hash === current)) return [];
  return [
    {
      code: 'X_DB_DRIFT',
      cause: `schema hashes to ${current}, newest migration ${latest.file} recorded ${latest.hash}`,
      fix: 'x db gen "describe the change"',
      docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
      at: `${DB_PACKAGE}/src`,
    },
  ];
}
