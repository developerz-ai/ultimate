// Where `x exercise` runs: a test process, pinned before the app loads, on a scratch migrated
// database installed as the ambient `db()` and thrown away after — never the developer's own (the
// pass COMMITS its rows), on the engine the schema dump replays on (`db-replay-engine.ts`), so the
// gate needs nothing listening, exactly as the `drift` step does not.

import type { Environment } from '@ultimat3/core';
import { ENVIRONMENT_KEY, resolveEnvironment, UltimateError, withStoreMode } from '@ultimat3/core';
import type { DbClient, Migration } from '@ultimat3/db';
import { dbExecutor, migrate, raw, setDbClient } from '@ultimat3/db';
import {
  captureDeterminism,
  installDeterminism,
  restoreCapturedDeterminism,
  testSealKeyEnv,
} from '@ultimat3/testing';
import { loadAppConfig } from './app-config-load';
import { chooseReplayEngine } from './db-replay-engine';
import { withPreparedScratch } from './db-replay-engine-prepared';
import { installExerciseServices } from './exercise-services';
import { applyFrameworkSchema, FRAMEWORK_SCHEMA, schemaStatements } from './framework-schema';
import { readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A deployed environment asked for the pass. `X_CONTRACT_EXERCISE_ENVIRONMENT`, core's code for
 * the same refusal one level down — with this command's fix, never `bun test`'s.
 */
export class ExerciseDeployRefusedError extends UltimateError {
  constructor(environment: Environment) {
    super({
      code: 'X_CONTRACT_EXERCISE_ENVIRONMENT',
      cause: `x exercise runs every handler on generated input, and ${ENVIRONMENT_KEY} resolved ${environment}: the pass runs in development or test only`,
      fix: `${ENVIRONMENT_KEY}=development x exercise --json   # from a checkout, never against a deploy`,
      meta: { environment },
    });
  }
}

/**
 * The environment the pass runs as: always `test`, once a deploy is refused. The pass is a test run
 * on a scratch database thrown away after it, and an app picks its store from this answer at module
 * load: a `development` app on its embedded memory store would read none of the rows seeded here.
 */
export function exerciseEnvironment(env: Env): Environment {
  const environment = resolveEnvironment({ env });
  if (environment !== 'development' && environment !== 'test') {
    throw new ExerciseDeployRefusedError(environment);
  }
  return 'test';
}

const PINNED = [ENVIRONMENT_KEY, 'NODE_ENV'] as const;

/**
 * `work` — the app's load and the pass — in a test process: the environment pinned BEFORE any app
 * module reads it, and the throwaway seal key `bun test` gets when the app supplied none (CI names
 * no `ULTIMATE_SECRETS_KEY`, and every row sealed here dies with the scratch database). Every
 * variable is put back as found: a command that exits must not leave the next one a test process.
 *
 * Core's `storeMode` is declared `database` for the length of `work` (`withStoreMode`).
 *
 * The frozen clock too, and FIRST — as `bun test`'s preload freezes it before any module loads. The
 * scratch database is PGlite, whose Postgres arms its timers off `Date.now()`: booted on the real
 * clock and frozen under later (the pass's room), its 10 s idle-stats timer was re-armed at
 * real-now minus frozen-now, ~2^34 ms, clamped to 1 ms — a `TimeoutOverflowWarning` busy loop for
 * the whole pass. One clock for the engine's whole life: the deadline and the delay agree.
 */
export async function withExerciseProcess<T>(
  root: string,
  env: Env,
  work: () => Promise<T>,
): Promise<T> {
  const environment = exerciseEnvironment(env);
  const pinned: Record<string, string> = Object.fromEntries(
    PINNED.map((key) => [key, environment]),
  );
  const added = { ...pinned, ...testSealKeyEnv({ root, env: { ...env, ...pinned } }) };
  const previous = Object.keys(added).map((key) => [key, process.env[key]] as const);
  const clock = captureDeterminism();
  if (!clock.installed) installDeterminism();
  Object.assign(process.env, added);
  try {
    // A test process ON a database: the scratch one `withExerciseDatabase` installs. A store an
    // app picks at load by core's `storeMode` (an api key, a device token) is that database's, or
    // every reach writing it sends no statement and proves nothing. `bun test` stays `memory`.
    return await withStoreMode('database', work);
  } finally {
    restoreCapturedDeterminism(clock);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * What decides a prepared scratch database: every framework statement, every migration's id and
 * text, and the extensions they link — hashed, so a new migration (or a framework release that
 * changes a table) is a new key and a miss. PGlite's own version is `@ultimat3/db`'s to add.
 */
export function exerciseSchemaKey(
  migrations: readonly Migration[],
  extensions: readonly string[],
): string {
  const hasher = new Bun.CryptoHasher('sha256');
  const part = (text: string): void => {
    hasher.update(`${String(text.length)}:${text}\u0000`);
  };
  for (const entry of FRAMEWORK_SCHEMA)
    for (const statement of schemaStatements(entry.ddl)) part(statement);
  part('--migrations--');
  for (const migration of migrations) {
    part(migration.id);
    part(migration.up);
  }
  part('--extensions--');
  for (const name of extensions) part(name);
  return hasher.digest('hex');
}

/**
 * Framework tables, then every migration — the order every real boot runs them in — then `work`
 * with the client installed. Released either way: a command that exits holding an installed
 * client would hand the next caller in this process a closed pool. The migrated state is kept
 * under the app's state dir (`db-replay-engine-prepared.ts`), so a second run restores it.
 */
export async function withExerciseDatabase<T>(
  root: string,
  env: Env,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const migrations = await readMigrations(root);
  const engine = await chooseReplayEngine(migrations, env);
  const { stateDir } = resolveServices(root, env);
  const extensions = engine.kind === 'embedded' ? engine.extensions : engine.requires;
  const preparation = {
    key: exerciseSchemaKey(migrations, extensions),
    prepare: async (client: DbClient) => {
      await applyFrameworkSchema((statement) => client.execute(raw(statement)));
      await migrate({ migrations, client });
    },
  };
  return withPreparedScratch(engine, stateDir, preparation, async (client) => {
    setDbClient(client);
    // What a server's boot installs beside its database, over this one: a primitive that reads a
    // disk, a shared rate limit or the push runtime runs, rather than needing `{ off }`.
    // Inside the `try`: a config or a key pair refused here still hands the client back.
    let release: () => void = () => undefined;
    try {
      release = await installExerciseServices({
        config: await loadAppConfig(root),
        env,
        executor: dbExecutor(() => client),
      });
      return await work(client);
    } finally {
      release();
      setDbClient(undefined);
    }
  });
}
