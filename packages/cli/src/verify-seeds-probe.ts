// The child `verify-seeds.ts` spawns: `bun verify-seeds-probe.ts <app root> <files as JSON>`, from
// the app's root. Every seed, in file order, on ONE scratch database — `x exercise`'s, with the
// framework schema and the app's migrations applied and installed as the ambient `db()` — so a
// seed's entity rows and what its `register()` writes land in the same place. Prints the failures.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { renderThrowable, stringField } from '@ultimat3/core';
import { withTransaction } from '@ultimat3/db';
import { isSeed, postgresDriver } from '@ultimat3/entity';
import { parse, t } from '@ultimat3/schema';
import { withExerciseDatabase, withExerciseProcess } from './exercise-database';
import type { SeedFailure, SeedStage } from './verify-seeds';
import { SEEDS_PROBE_MARKER } from './verify-seeds';
import { writeLine } from './write-line';

type Env = Readonly<Record<string, string | undefined>>;

const failure = (
  stage: SeedStage,
  where: { file: string; export: string; seed: string },
  error: unknown,
): SeedFailure => ({
  stage,
  ...where,
  code: stringField(error, 'code') ?? null,
  cause: stringField(error, 'cause') ?? null,
  fix: stringField(error, 'fix') ?? null,
  message: stringField(error, 'message') ?? renderThrowable(error),
});

/**
 * One transaction PER SEED, as `x db seed` runs them (`db-seed.ts`): a seed that throws takes only
 * its own rows with it, and a later seed still reads what an earlier one committed. `db()` inside
 * the transaction IS the transaction, so `register()` joins it without knowing.
 */
async function runEach(root: string, files: readonly string[]): Promise<readonly SeedFailure[]> {
  const driver = postgresDriver();
  const failures: SeedFailure[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(join(root, file));
    } catch (error) {
      failures.push(failure('import', { file, export: '*', seed: '*' }, error));
      continue;
    }
    for (const [name, value] of Object.entries(mod)) {
      if (!isSeed(value)) continue;
      try {
        await withTransaction(() => value.run({ driver }));
      } catch (error) {
        failures.push(failure('run', { file, export: name, seed: value.name }, error));
      }
    }
  }
  return failures;
}

/**
 * The seed run's failures for the app at `root` — one database for the whole run, discarded after.
 * A database that would not open (a migration that fails, an extension PGlite cannot link and no
 * `TEST_DATABASE_URL`) is one failure at stage `database`, carrying that refusal's own code and fix.
 */
export async function probeSeeds(
  root: string,
  files: readonly string[],
  env: Env,
): Promise<readonly SeedFailure[]> {
  try {
    return await withExerciseProcess(root, env, () =>
      withExerciseDatabase(root, env, () => runEach(root, files)),
    );
  } catch (error) {
    return [failure('database', { file: files[0] ?? '*', export: '*', seed: '*' }, error)];
  }
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const files = parse(t.array(t.string), JSON.parse(process.argv[3] ?? '[]'));
  const failures = await probeSeeds(root, files, { ...process.env });
  writeLine(`${SEEDS_PROBE_MARKER}${JSON.stringify(failures)}`);
  // PGlite and the services `withExerciseDatabase` installed are released; anything a seed left
  // open (a timer, a socket) must not hold the gate's step until its deadline.
  process.exit(0);
}
