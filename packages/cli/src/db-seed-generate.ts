// `x db seed --generate [--rows n] [--seed n]`: rows for every registered entity, off the entity
// declarations alone (`@ultimat3/testing`'s `seedGraph`), written through each entity's own
// repository. Generated rows are `dev` fixtures — the same graph `x exercise` runs on — so
// production is refused whatever tier is asked for. One pass is one row of `x db seed`'s report.

import type { Environment } from '@ultimat3/core';
import { resolveEnvironment, UltimateError } from '@ultimat3/core';
import { withTransaction } from '@ultimat3/db';
import type { EntityCore, SeedTier } from '@ultimat3/entity';
import { postgresDriver, registeredEntities, seedTiersFor } from '@ultimat3/entity';
import type { SeedGraph, SeedWriter } from '@ultimat3/testing';
import { entitySeedWriter, insertSeedGraph, seedGraph } from '@ultimat3/testing';
import { loadApp } from './app-load';
import type { CommandContext } from './command';
import type { SeedPassRow } from './db-seed';
import { parseSeedTierFlag, renderSeedTable, seedPassToJson } from './db-seed';
import { readIntFlag } from './flag-number';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult } from './output';
import { findingFrom } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';

/** The name a generated pass reports under: a seed name no `defineSeed` can be confused with. */
export const GENERATED_SEED = '(generated)';

/** What `refuseGeneratedSeed` answers: the tier generated rows are, in every report. */
const GENERATED_TIER: SeedTier = 'dev';

/**
 * Generated rows asked for where they must not land. `X_SEED_ENVIRONMENT`, the code `x db seed`
 * already answers "this environment does not run that tier" with — but never its fix: a generated
 * graph has no natural key to replay against, so no tier name makes production take it.
 */
export class GeneratedSeedRefusedError extends UltimateError {
  constructor(environment: Environment, tiers: readonly SeedTier[]) {
    super({
      code: 'X_SEED_ENVIRONMENT',
      cause: `x db seed --generate writes dev fixture rows, and ULTIMATE_ENV resolved ${environment}, where this run takes ${tiers.join(', ')} — generated rows never reach production, whatever tier is named`,
      fix: 'ULTIMATE_ENV=development x db seed --generate --dry-run --json',
    });
  }
}

/** Throws unless this environment takes `dev` rows and is not production. */
export function refuseGeneratedSeed(
  environment: Environment,
  requested: SeedTier | undefined,
): void {
  const tiers = seedTiersFor(environment, requested);
  if (environment === 'production' || !tiers.includes(GENERATED_TIER)) {
    throw new GeneratedSeedRefusedError(environment, tiers);
  }
}

export interface GeneratedSeedFlags {
  readonly rows?: number;
  readonly seed?: number;
}

/** `--rows` (at least one) and `--seed`, through the one integer reader. */
export function generatedSeedFlags(args: ParsedArgs): GeneratedSeedFlags {
  const rows = readIntFlag(args, {
    name: 'rows',
    command: 'db seed',
    min: 1,
    max: 10_000,
    example: 'x db seed --generate --rows 3 --json',
  });
  const seed = readIntFlag(args, {
    name: 'seed',
    command: 'db seed',
    min: 0,
    max: 2_147_483_647,
    example: 'x db seed --generate --seed 1 --json',
  });
  return { ...(rows === undefined ? {} : { rows }), ...(seed === undefined ? {} : { seed }) };
}

/** The plan: `--rows` per table (per tenant when scoped), drawn from `--seed`. */
export const generatedSeedPlan = (
  entities: Readonly<Record<string, EntityCore>>,
  flags: GeneratedSeedFlags,
): SeedGraph =>
  seedGraph(entities, {
    ...(flags.rows === undefined ? {} : { perTable: flags.rows }),
    ...(flags.seed === undefined ? {} : { seed: flags.seed }),
  });

export interface GeneratedSeedWrite {
  readonly graph: SeedGraph;
  readonly writer: SeedWriter;
  readonly dryRun: boolean;
  /** One transaction around the whole graph: half a graph is a child row with no parent. */
  readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Writes the plan, or counts it under `--dry-run`. Never throws — a failure is the row. */
export async function writeGeneratedSeed(input: GeneratedSeedWrite): Promise<SeedPassRow> {
  const started = Bun.nanoseconds();
  const ms = (): number => Math.round((Bun.nanoseconds() - started) / 1_000_000);
  const base = { file: GENERATED_SEED, name: GENERATED_SEED, tier: GENERATED_TIER, skipped: 0 };
  try {
    if (!input.dryRun) await input.transaction(() => insertSeedGraph(input.graph, input.writer));
    return {
      ...base,
      status: 'ok',
      ms: ms(),
      inserted: input.graph.inserts.length,
      updated: input.graph.updates.length,
      finding: null,
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      ms: ms(),
      inserted: 0,
      updated: 0,
      finding: findingFrom(error),
    };
  }
}

/**
 * Every registered TABLE, by name — the set the plan and the writer are both handed. A view entity
 * is left out: Postgres derives its rows, and a write to one is `X_ENTITY_VIEW_READ_ONLY`.
 */
export const registeredEntityCores = (): Readonly<Record<string, EntityCore>> =>
  Object.fromEntries(
    registeredEntities().flatMap((entry) =>
      entry.core === undefined || entry.core.$viewQuery !== null
        ? []
        : [[entry.name, entry.core as EntityCore]],
    ),
  );

/**
 * The command half. The environment is refused BEFORE the app loads or a connection opens, the
 * rule `runSeed` keeps for the same reason: the refusal must not have touched the database first.
 */
export async function runGeneratedSeed(ctx: CommandContext, root: string): Promise<CommandResult> {
  const environment = resolveEnvironment({ env: ctx.env });
  const requested = parseSeedTierFlag(
    flagString(ctx.args, 'tier') ?? ctx.env['ULTIMATE_SEED_TIER'],
  );
  refuseGeneratedSeed(environment, requested);
  const flags = generatedSeedFlags(ctx.args);
  const dryRun = flagBool(ctx.args, 'dry-run');
  const { findings } = await loadApp(root);
  const entities = registeredEntityCores();
  const graph = generatedSeedPlan(entities, flags);
  const write = (): Promise<CommandResult> =>
    writeGeneratedSeed({
      graph,
      writer: entitySeedWriter({ entities, driver: postgresDriver() }),
      dryRun,
      transaction: (work) => withTransaction(() => work()),
    }).then((row) => generatedResult(row, dryRun, findings));
  return dryRun ? write() : withJobDriver(root, ctx, write);
}

function generatedResult(
  row: SeedPassRow,
  dryRun: boolean,
  findings: CommandResult['findings'],
): CommandResult {
  const loaded = findings ?? [];
  return {
    ok: row.finding === null && loaded.length === 0,
    command: 'db',
    summary:
      row.finding !== null
        ? msg('cli.db.seed.failed', { failed: 1, count: 1 })
        : dryRun
          ? msg('cli.db.seed.dryRun', { count: 1 })
          : msg('cli.db.seed.done', {
              count: 1,
              inserted: row.inserted,
              updated: row.updated,
              skipped: row.skipped,
            }),
    findings: [...(row.finding === null ? [] : [row.finding]), ...loaded],
    lines: renderSeedTable([row]).map((line) => `  ${line}`),
    data: seedPassToJson([row]),
  };
}
