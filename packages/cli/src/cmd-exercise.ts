// `x exercise [<name>] [--seed n]` — every action, query and job run once against generated rows,
// with no test written: load the app, read `apps/web/exercise.ts`, run `@ultimat3/testing`'s pass
// on a scratch database, write `.x/exercise.json`. CLI wiring only: the pass is testing's, the
// verdict is `exercise-findings.ts`'s, so the gate step and this command read one rule.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import { describeEntities } from '@ultimat3/entity';
import type { NamedActor } from '@ultimat3/policy';
import type { ExerciseRecord, SeedEntity } from '@ultimat3/testing';
import { entitySeedWriter, runExercisePass } from '@ultimat3/testing';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { exerciseSpec } from './cmd-exercise-spec';
import type { CliCommand, CommandContext } from './command';
import { registeredEntityCores } from './db-seed-generate';
import { devActors } from './dev-policy';
import { withExerciseDatabase, withExerciseProcess } from './exercise-database';
import {
  EXERCISE_REPORT_FILE,
  exerciseFindings,
  exerciseReport,
  renderExerciseTable,
} from './exercise-findings';
import { readExerciseOverrides } from './exercise-overrides';
import { entityTenantFindings } from './exercise-static';
import { readIntFlag } from './flag-number';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';

/**
 * The actors `x policy explain` evaluates — `devActors()`, the `/_x` panel's own set — each a
 * member of `tenant`. Never a second "every role" builder: the pass picks among exactly these.
 */
export const exerciseRoles = (tenant: string): readonly NamedActor[] =>
  devActors().map((named) =>
    named.actor === null ? named : { ...named, actor: { ...named.actor, orgId: tenant } },
  );

const readSeed = (ctx: CommandContext): number | undefined =>
  readIntFlag(ctx.args, {
    name: 'seed',
    command: 'exercise',
    min: 0,
    max: 2_147_483_647,
    example: 'x exercise --seed 1 --json',
  });

export const exerciseCommand: CliCommand = {
  spec: exerciseSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('exercise', ctx.cwd).dir;
    const seed = readSeed(ctx);
    return withExerciseProcess(root, ctx.env, () => exercise(ctx, root, seed));
  },
};

async function exercise(
  ctx: CommandContext,
  root: string,
  seed: number | undefined,
): Promise<CommandResult> {
  const only = ctx.args.positionals[0];
  const loaded = await loadApp(root);
  const overrides = await readExerciseOverrides(root);
  const cores = registeredEntityCores();
  const entities: readonly SeedEntity[] = Object.values(cores);
  const records: readonly ExerciseRecord[] = await withExerciseDatabase(root, ctx.env, (client) =>
    runExercisePass({
      entities,
      writer: entitySeedWriter({ entities: cores, client }),
      ...(seed === undefined ? {} : { seed }),
      ...(overrides === undefined ? {} : { overrides }),
      ...(only === undefined ? {} : { only }),
      roles: exerciseRoles,
    }),
  );
  const report = exerciseReport(records, seed);
  // The whole pass, not a one-primitive run's slice of it, is what the file is for — but a
  // one-primitive run is still a fact worth keeping, so it is written either way.
  await Bun.write(join(root, EXERCISE_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  const findings = [
    ...loaded.findings,
    // The static half of the tenant proof (`exercise-static.ts`): the pass's own question,
    // asked of the declarations before any row is written.
    ...(only === undefined ? entityTenantFindings(describeEntities()) : []),
    ...exerciseFindings(records),
  ];
  return {
    ok: findings.length === 0,
    command: 'exercise',
    summary:
      records.length === 0
        ? msg('cli.exercise.none')
        : msg('cli.exercise.summary', { ...report.counts, file: EXERCISE_REPORT_FILE }),
    lines: renderExerciseTable(records).map((line) => `  ${line}`),
    findings,
    data: report as unknown as JsonValue,
  };
}
