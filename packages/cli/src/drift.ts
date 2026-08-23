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
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { describeEntities } from '@ultimat3/entity';
import { countDeclaredEntities } from './app-entities';
import { loadApp } from './app-load';
// One declaration of where migrations live, and it belongs to the module that reads them —
// `x db migrate` and this sidecar must never disagree about the directory they share.
import { hashFileName, MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';

export const DB_PACKAGE = join('packages', 'db');
const SCHEMA_GLOB = 'packages/db/src/**/*.ts';

/**
 * Canonical JSON: object keys sorted, arrays in their own order. The registry's description is a
 * BUILD INPUT committed to disk as a hash, so a field reordered inside `describe()` upstream would
 * otherwise move every app's hash and report drift over a framework upgrade nobody made.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonicalJson(held)}`).join(',')}}`;
  }
  // `undefined` has no JSON form and an optional field left unset must hash as absent, not throw.
  return JSON.stringify(value) ?? 'null';
}

/**
 * What the app's entities declare, as the registry describes them — the half `SCHEMA_GLOB` cannot
 * see. `x new` puts an entity at `apps/web/app/<feature>/entity.ts` and `packages/db/src/schema.ts`
 * merely re-exports it, so a column added there moved NO byte the glob reads: three generated
 * entities and one migration reported clean, with every `.hash` sidecar identical. The registry is
 * the same fact `x db gen` diffs (`describeEntities()`), so the check and the generator now read
 * one schema instead of two.
 *
 * `loadApp` is what fills that registry, and it is called on every path rather than only where the
 * caller happens to have loaded already: a hash computed against an EMPTY registry would differ
 * from the one `x db gen` recorded with the app loaded, and every app would read as drifted.
 * A module that will not import leaves the registry SHORT rather than raising — the stance
 * `countDeclaredEntities` already documents — so `x doctor` still answers on the app it diagnoses.
 */
async function declaredSchemaJson(root: string): Promise<string> {
  await loadApp(root);
  return canonicalJson(describeEntities());
}

/**
 * Content hash of the whole schema: the entity registry first, then every non-test file under
 * `packages/db/src`, order-independent per file path. Both halves, because they answer different
 * questions — the registry is what reaches the database, and the glob is what catches a seed or a
 * helper moving under it (which is what `reconcileSchemaHash` exists to re-record).
 */
export async function schemaHash(root: string): Promise<string> {
  const glob = new Bun.Glob(SCHEMA_GLOB);
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: root, absolute: false })) {
    if (!path.includes('.test.')) paths.push(path);
  }
  paths.sort();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await declaredSchemaJson(root));
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
 * "Some migration recorded this hash" — the one predicate, read by the check below AND by the
 * reconcile above it. Two spellings would let `x db gen` report the sidecar written while
 * `x verify` still reports drift over the same two files.
 */
const isRecorded = (records: readonly MigrationRecord[], hash: string): boolean =>
  records.some((record) => record.hash === hash);

export interface HashReconciliation {
  readonly hash: string;
  /** False when a sidecar already held this hash — nothing was written, and nothing needed to be. */
  readonly written: boolean;
}

/**
 * Re-record the sidecar for a migration that is already the right one. Neither half of the hash is
 * DDL-only — `SCHEMA_GLOB` covers every non-test file under `packages/db/src`, and the registry
 * carries invariants and tags a diff can leave empty — so an edit can move the hash with no
 * statement behind it, and `X_DB_DRIFT`'s `fix:` has to have somewhere to
 * land or the instruction is unfollowable. The caller owes the proof that the DDL genuinely did not
 * move (`db-generate.ts` reaches this only on an empty diff off a fully loaded registry); this
 * function decides only whether a write is needed.
 *
 * A hash an OLDER migration recorded is left alone: `checkSourceDrift` already answers clean on it,
 * and stamping the newest sidecar would claim that migration produced a schema it did not.
 */
export async function reconcileSchemaHash(
  root: string,
  migrationId: string,
): Promise<HashReconciliation> {
  const hash = await schemaHash(root);
  if (isRecorded(await recordedHashes(root), hash)) return { hash, written: false };
  await Bun.write(join(root, MIGRATIONS_DIR, hashFileName(migrationId)), `${hash}\n`);
  return { hash, written: true };
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
 * The entity count is read lazily and ONLY in that first branch; the hash itself loads the app on
 * every path, because the registry is half of what it covers. Still no database anywhere here,
 * which is what lets the gate run this in a CI with nothing listening.
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
    //
    // An empty diff still writes no `.hash` HERE, and must: `reconcileSchemaHash` needs a migration
    // id to record against and there is no migration at all in this branch. With an entity declared
    // the diff is never empty — a registry against zero migrations is `create table` for all of
    // it — so this branch's fix stays the real generation it always was.
    if ((await declaredEntities()) === 0) return [];
    return [
      {
        code: 'X_DB_DRIFT',
        cause: 'packages/db has a schema but no migration recorded it',
        fix: 'x db gen "initial"',
        docs: ERROR_DOCS_URL,
        at: MIGRATIONS_DIR,
      },
    ];
  }
  if (isRecorded(records, current)) return [];
  return [
    {
      code: 'X_DB_DRIFT',
      cause: `schema hashes to ${current}, newest migration ${latest.file} recorded ${latest.hash}`,
      fix: 'x db gen "describe the change"',
      docs: ERROR_DOCS_URL,
      at: `${DB_PACKAGE}/src`,
    },
  ];
}
