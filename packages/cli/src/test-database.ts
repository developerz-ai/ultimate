// Single responsibility: the app's migrated test database — a fresh embedded Postgres holding the
// framework schema (`x_jobs`, `x_users`, …) and every app migration, exactly what `x db migrate`
// and `x dev` apply, so a test exercises the schema production runs and never a hand copy of it.
//
// Booted from a cached TEMPLATE: the migrated data directory, dumped once per (PGlite, framework
// schema, migrations) and kept under the APP ROOT's `.x/test-db` (`test-db-template.ts`). A fresh
// in-memory PGlite runs initdb (~4 s) and then every migration in every test file; restoring the
// dump is ~0.5 s. A changed migration is a different key, so a stale template is never loaded, and
// writing the new one evicts the old ones (#738). An app's hand-rolled copy of this kept them all.
//
// Per-test data hygiene is `reusableDatabase` (`@ultimat3/testing`): one database per test worker,
// its data put back to this template's before every file. The wiki's Testing page is the recipe.

import { appDirOf, assert } from '@ultimat3/core';
import {
  migrate,
  PGLITE_PACKAGE,
  type PgliteClient,
  type PgliteModule,
  pgliteClient,
  pgliteVersion,
  raw,
} from '@ultimat3/db';
import { applyFrameworkSchema, FRAMEWORK_SCHEMA } from './framework-schema';
import { readMigrations } from './migrations';
import { readTemplate, templateKey, templatePath, writeTemplate } from './test-db-template';

export interface MigratedDatabaseOptions {
  /** The app root, or any folder inside the app: the template lives under the root's `.x/`. */
  readonly root: string;
  /** A directory to put the database ON DISK instead of in memory (an empty one), for a test whose second process opens it. */
  readonly dataDir?: string | undefined;
  /** Extensions a migration creates (`citext`): PGlite links one only when told at boot. */
  readonly extensions?: readonly string[] | undefined;
}

interface DumpablePglite {
  dumpDataDir(compression?: 'none'): Promise<Blob>;
}

type PgliteClass = PgliteModule['PGlite'];

/** Held in a variable, as `@ultimat3/db` holds it: a literal would make `tsc` resolve an optional peer. */
const importPglite = async (): Promise<PgliteClass> =>
  ((await import(PGLITE_PACKAGE)) as unknown as PgliteModule).PGlite;

/** One template per key for the life of the process: the second file in a worker reads no disk. */
const held = new Map<string, Blob>();

/** Bumped when how a template is BUILT changes, so a template built the old way is rebuilt. */
const TEMPLATE_RECIPE = 'framework-schema+migrations+checkpoint:1';

async function buildTemplate(
  PGlite: PgliteClass,
  root: string,
  extensions: readonly string[] | undefined,
): Promise<Blob> {
  // Built through the framework's own loader (its parsers, its extension linking), with the
  // instance captured so its data directory can be dumped once the schema is in.
  let driver: DumpablePglite | undefined;
  const Capturing = class extends (PGlite as unknown as new (...args: unknown[]) => object) {
    constructor(...args: unknown[]) {
      super(...args);
      driver = this as unknown as DumpablePglite;
    }
  } as unknown as PgliteClass;
  const client = pgliteClient({
    load: async () => ({ PGlite: Capturing }),
    ...(extensions === undefined ? {} : { extensions }),
  });
  try {
    await applyFrameworkSchema((statement) => client.execute(raw(statement)));
    await migrate({ migrations: await readMigrations(root), client, lock: false });
    // Without a checkpoint every boot from the template replays the migrations' WAL as crash
    // recovery (~130 ms of each ~600 ms boot, measured on notificado.co).
    await client.execute(raw('CHECKPOINT'));
    const captured = driver as DumpablePglite | undefined;
    assert(
      captured !== undefined,
      'the migrated test template ran its schema, and no PGlite instance was constructed to dump',
      'report it: pgliteClient booted a driver this module did not hand it',
    );
    return await captured.dumpDataDir('none');
  } finally {
    await client.close();
  }
}

/** The migrated template for the app `root` is in: from memory, from `.x/test-db`, or built now. */
export async function migratedTemplate(options: MigratedDatabaseOptions): Promise<Blob> {
  const PGlite = await importPglite();
  // The migrations are read from the app ROOT whichever folder the caller named.
  const root = appDirOf(options.root) ?? options.root;
  const key = templateKey([
    (await pgliteVersion()) ?? 'unknown',
    JSON.stringify(FRAMEWORK_SCHEMA),
    JSON.stringify(await readMigrations(root)),
    JSON.stringify(options.extensions ?? []),
    TEMPLATE_RECIPE,
  ]);
  const memo = held.get(key);
  if (memo !== undefined) return memo;
  const path = templatePath(root, key);
  const template =
    (await readTemplate(path)) ??
    (await (async () => {
      const built = await buildTemplate(PGlite, root, options.extensions);
      await writeTemplate(path, built);
      return built;
    })());
  held.set(key, template);
  return template;
}

/**
 * A fresh database with the framework schema and every migration applied, booted from the cached
 * template. The caller owns it: `close()` when done. It is not installed as `db()` — the recipe
 * (`reusableDatabase` + `setDbClient`) does that.
 */
export async function migratedDatabase(options: MigratedDatabaseOptions): Promise<PgliteClient> {
  const PGlite = await importPglite();
  const template = await migratedTemplate(options);
  const FromTemplate = class extends (PGlite as unknown as new (...args: unknown[]) => object) {
    constructor(dataDir?: unknown, init?: Record<string, unknown>) {
      super(dataDir, { ...init, loadDataDir: template });
    }
  } as unknown as PgliteClass;
  return pgliteClient({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    load: async () => ({ PGlite: FromTemplate }),
  });
}
