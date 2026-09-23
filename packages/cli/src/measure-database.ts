// The database a measurement render reads, when the build has none. A page's `load` reads rows,
// and a build runs with no `DATABASE_URL`, so every data-reading route was `X_DB_UNAVAILABLE` and
// never weighed. The answer is `x dev`'s own embedded PGlite on a THROWAWAY state directory, with
// the app's migrations applied and its `dev`-tier seeds run: `defineSeed` rows are keyed by
// `seedId(label)`, so the database is the same on every machine — and a dynamic route whose
// `prerender()` lists paths from its own rows has paths to be weighed at (plan 101 slice 11 m).

// why: Bun has no mkdtemp and no recursive remove; the state directory must not outlive the build.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); the throwaway directory lives in the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { migrate, withTransaction } from '@ultimat3/db';
import { postgresDriver } from '@ultimat3/entity';
import { discoverSeeds, runSeeds, selectSeeds } from './db-seed';
import { readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';

type Env = Readonly<Record<string, string | undefined>>;

/** One build's database: started on first use, released once. */
export interface MeasureDatabase {
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `x dev`'s embedded database, empty and migrated, for an env with no `DATABASE_URL`. An env that
 * names one keeps it: `db()` already reaches that server, and a build pointed at a database was
 * pointed there on purpose.
 */
export function measureDatabase(root: string, env: Env = process.env): MeasureDatabase {
  let started: Promise<() => Promise<void>> | undefined;
  const start = async (): Promise<() => Promise<void>> => {
    if ((env['DATABASE_URL'] ?? '') !== '') return async () => undefined;
    // An app with no migration has no table to read, so it pays for no database: a PGlite boot
    // is seconds, and every build of such an app (and every prerender test) paid it for nothing.
    const migrations = await readMigrations(root);
    if (migrations.length === 0) return async () => undefined;
    const state = await mkdtemp(join(tmpdir(), 'x-measure-'));
    const scoped = { ...env, ULTIMATE_STATE_DIR: state };
    const queue = await startQueue(resolveServices(root, scoped), undefined, scoped);
    await migrate({ migrations });
    // The seeds `x db seed` runs in development. A failed seed is a row in its own result and
    // never a thrown build: a route it starves is reported by the measurement that needed it.
    const discovered = (await discoverSeeds(root)).seeds;
    await runSeeds({
      seeds: selectSeeds({ discovered, environment: 'development' }),
      driver: postgresDriver(),
      dryRun: false,
      env: scoped,
      transaction: (work) => withTransaction(() => work()),
    });
    return async () => {
      await queue.stop();
      await rm(state, { recursive: true, force: true });
    };
  };
  return {
    ready: async () => {
      started ??= start();
      await started;
    },
    close: async () => {
      if (started === undefined) return;
      const stop = await started;
      started = undefined;
      await stop();
    },
  };
}
