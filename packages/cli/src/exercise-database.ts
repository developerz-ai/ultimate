// Where `x exercise` runs: a test process, pinned before the app loads, on a scratch migrated
// database installed as the ambient `db()` and thrown away after — never the developer's own (the
// pass COMMITS its rows), on the engine the schema dump replays on (`db-replay-engine.ts`), so the
// gate needs nothing listening, exactly as the `drift` step does not.

import type { Environment } from '@ultimat3/core';
import { ENVIRONMENT_KEY, resolveEnvironment, UltimateError } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { migrate, raw, setDbClient } from '@ultimat3/db';
import {
  captureDeterminism,
  installDeterminism,
  restoreCapturedDeterminism,
  testSealKeyEnv,
} from '@ultimat3/testing';
import { chooseReplayEngine, withScratchDatabase } from './db-replay-engine';
import { applyFrameworkSchema } from './framework-schema';
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
    return await work();
  } finally {
    restoreCapturedDeterminism(clock);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Framework tables, then every migration — the order every real boot runs them in — then `work`
 * with the client installed. Released either way: a command that exits holding an installed
 * client would hand the next caller in this process a closed pool.
 */
export async function withExerciseDatabase<T>(
  root: string,
  env: Env,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const migrations = await readMigrations(root);
  const engine = await chooseReplayEngine(migrations, env);
  const { stateDir } = resolveServices(root, env);
  return withScratchDatabase(engine, stateDir, async (client) => {
    await applyFrameworkSchema((statement) => client.execute(raw(statement)));
    await migrate({ migrations, client });
    setDbClient(client);
    try {
      return await work(client);
    } finally {
      setDbClient(undefined);
    }
  });
}
