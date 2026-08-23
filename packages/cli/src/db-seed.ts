// `x db seed`, everything except the argv: where a seed is declared, which tier this environment
// takes, and what one pass reports. A driver plus plain strings in, plain rows out — the
// `db-backfill.ts` split repeated, so every rule here is testable with no `ParsedArgs` and no boot.
//
// The decisions a seed itself owns are `@ultimat3/entity`'s: `seedTiersFor` is the one table saying
// which tiers an environment runs, and two copies of "may this seed run" would be two answers.

// `node:path` for the joiner and the app-root-relative spelling every finding is keyed by; Bun
// exposes neither.
import { relative, sep } from 'node:path';
import type { Environment } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import type { Driver, Seed, SeedTier } from '@ultimat3/entity';
import { isSeed, SEED_TIERS, seedTiersFor } from '@ultimat3/entity';
import { BadFlagError } from './errors';
import type { Finding, JsonValue } from './output';
import { findingFrom } from './output';
import { renderTable } from './table';

/**
 * Where an app keeps seeds: a `seeds` directory in a package, or a `seed*.ts` beside its entities —
 * the two layouts the tracked apps already use, and nothing wider. `loadApp`'s whole-src glob was
 * the alternative and it is the wrong tool here: importing every module of every package to find a
 * fixture graph makes an unrelated module that will not import into a failed seed run.
 * `apps/` is deliberately absent: a fixture graph is data, and data lives in a package.
 */
export const SEED_GLOBS = ['packages/*/seeds/**/*.ts', 'packages/*/src/seed*.ts'] as const;

/**
 * `x db seed <name>` named a seed no module declared. `X_DECLARATION_UNKNOWN` is the code the
 * registries already answer this with — a seed is a declaration, and a second code for "no such
 * name" is the synonym the registry exists to prevent. The known names ARE listed, unlike
 * `DeclarationUnknownError`'s count: an app has one to five seeds, not two hundred actions, and
 * picking another one is the entire remedy.
 *
 * Both classes live HERE rather than in `errors.ts` for one reason, stated so nobody has to guess:
 * that file is at the 500-line ceiling `x verify`'s `filesize` step enforces, and these two are
 * `x db seed`'s alone. The codes stay CLI-owned in `error-codes.ts`, as every code does.
 */
export class SeedUnknownError extends UltimateError {
  constructor(input: { name: string; known: readonly string[] }) {
    super({
      code: 'X_DECLARATION_UNKNOWN',
      cause:
        input.known.length === 0
          ? `no seed named "${input.name}" — this app declares none (a seed is an exported defineSeed() in packages/<pkg>/seeds or packages/<pkg>/src/seed.ts)`
          : `no seed named "${input.name}" is declared (known: ${input.known.join(', ')})`,
      // A dry run, never a bare `x db seed`: the command that answers "which seeds are there" must
      // not be the command that writes them.
      fix: 'x db seed --dry-run --json',
    });
  }
}

/**
 * The seed's tier is not one this environment runs. `dev` fixtures reaching production is the one
 * irreversible mistake `x db seed` can make, so it is refused rather than confirmed.
 *
 * `X_SEED_ENVIRONMENT` is its own code, not `X_CLI_BAD_FLAG`: the argv was well formed and the
 * answer is still no. A flag code says "you typed it wrong" and sends the reader to `x help`; this
 * says "this environment does not run that tier", whose one remedy is naming the tier. The env var
 * is named in the cause and not in the `fix:`, because a `fix:` is one pasteable line and a
 * container with a fixed command line is the case that needs the other half.
 */
export class SeedEnvironmentError extends UltimateError {
  constructor(input: {
    seed: string;
    tier: string;
    environment: string;
    tiers: readonly string[];
  }) {
    super({
      code: 'X_SEED_ENVIRONMENT',
      cause: `seed "${input.seed}" is tier ${input.tier} and ULTIMATE_ENV resolved ${input.environment}, where x db seed runs ${input.tiers.join(', ')} — ULTIMATE_SEED_TIER=${input.tier} says this deploy takes it anyway`,
      fix: `x db seed ${input.seed} --tier ${input.tier} --json`,
    });
  }
}

export interface DiscoveredSeed {
  readonly seed: Seed;
  /** App-root-relative POSIX path of the module that declared it. */
  readonly file: string;
}

export interface SeedDiscovery {
  readonly seeds: readonly DiscoveredSeed[];
  /** Modules that would not import. Reported, never swallowed: one of them may hold the seed. */
  readonly findings: readonly Finding[];
}

/**
 * Every seed the app declares, by importing the modules that declare them — the same rule
 * `loadApp` follows, because importing IS the declaration. Sorted by file, so a run's order is the
 * one a reader can predict from the tree (`01_orgs.ts` before `02_posts.ts`) rather than the one a
 * glob happened to yield.
 */
export async function discoverSeeds(root: string): Promise<SeedDiscovery> {
  const seeds: DiscoveredSeed[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const pattern of SEED_GLOBS) {
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      if (absolute.includes('node_modules') || absolute.includes('.test.')) continue;
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const file = relative(root, absolute).split(sep).join('/');
      let module: Record<string, unknown>;
      try {
        module = (await import(absolute)) as Record<string, unknown>;
      } catch (error) {
        findings.push({ ...findingFrom(error), at: file });
        continue;
      }
      for (const value of Object.values(module)) {
        if (isSeed(value)) seeds.push({ seed: value, file });
      }
    }
  }
  return {
    seeds: seeds.toSorted((left, right) => left.file.localeCompare(right.file)),
    findings,
  };
}

/** `--tier`, or `ULTIMATE_SEED_TIER` for a container whose command line is fixed. */
export function parseSeedTierFlag(value: string | undefined): SeedTier | undefined {
  if (value === undefined || value === '') return undefined;
  if ((SEED_TIERS as readonly string[]).includes(value)) return value as SeedTier;
  throw new BadFlagError({
    flag: 'tier',
    command: 'db seed',
    reason: `unknown tier "${value}" (known: ${SEED_TIERS.join(', ')})`,
    fix: 'x db seed --dry-run --json',
  });
}

export interface SeedSelection {
  readonly discovered: readonly DiscoveredSeed[];
  /** The positional. Absent runs every seed whose tier this environment takes. */
  readonly name?: string | undefined;
  readonly environment: Environment;
  readonly requested?: SeedTier | undefined;
}

/**
 * Which seeds this invocation runs, and the two refusals that are not a run.
 *
 * The environment check is HERE and again in `cmd-db.ts` before the driver is booted, on purpose:
 * seeding is the one irreversible thing this command does, and the layer that boots a connection
 * to production must not be the only layer that decided it was allowed to.
 */
export function selectSeeds(input: SeedSelection): readonly DiscoveredSeed[] {
  const tiers = seedTiersFor(input.environment, input.requested);
  const known = input.discovered.map((entry) => entry.seed.name);
  if (input.name === undefined) {
    return input.discovered.filter((entry) => tiers.includes(entry.seed.tier));
  }
  const chosen = input.discovered.filter((entry) => entry.seed.name === input.name);
  const first = chosen[0];
  if (first === undefined) throw new SeedUnknownError({ name: input.name, known });
  if (chosen.length > 1) {
    throw new BadFlagError({
      flag: 'name',
      command: 'db seed',
      reason: `"${input.name}" names ${chosen.length} seeds (${chosen.map((entry) => entry.file).join(', ')}) — a seed name is how a run is asked for, so two of them make the ask unanswerable`,
      fix: 'x db seed --dry-run --json',
    });
  }
  if (!tiers.includes(first.seed.tier)) {
    throw new SeedEnvironmentError({
      seed: first.seed.name,
      tier: first.seed.tier,
      environment: input.environment,
      tiers,
    });
  }
  return chosen;
}

export type SeedStatus = 'ok' | 'failed';

export interface SeedPassRow {
  readonly file: string;
  readonly name: string;
  readonly tier: SeedTier;
  readonly status: SeedStatus;
  readonly ms: number;
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly finding: Finding | null;
}

export interface SeedPassOptions {
  readonly seeds: readonly DiscoveredSeed[];
  readonly driver: Driver;
  readonly dryRun: boolean;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * One transaction PER SEED, never one around the run: a seed that fails must not roll back the
   * ones that already succeeded, and a fixture graph half-written is worse than one not written.
   * Injected so this stays testable with no database; `cmd-db.ts` passes `withTransaction`.
   */
  readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Each seed, in file order, each isolated from the next. Never throws — a failure is a row. */
export async function runSeeds(options: SeedPassOptions): Promise<readonly SeedPassRow[]> {
  const rows: SeedPassRow[] = [];
  for (const entry of options.seeds) {
    const started = Bun.nanoseconds();
    const elapsed = (): number => Math.round((Bun.nanoseconds() - started) / 1_000_000);
    try {
      const run = await options.transaction(() =>
        entry.seed.run({ driver: options.driver, dryRun: options.dryRun, env: options.env }),
      );
      rows.push({
        file: entry.file,
        name: run.name,
        tier: run.tier,
        status: 'ok',
        ms: elapsed(),
        ...run.metrics,
        finding: null,
      });
    } catch (error) {
      rows.push({
        file: entry.file,
        name: entry.seed.name,
        tier: entry.seed.tier,
        status: 'failed',
        ms: elapsed(),
        inserted: 0,
        updated: 0,
        skipped: 0,
        finding: { ...findingFrom(error), at: entry.file },
      });
    }
  }
  return rows;
}

export interface SeedTotals {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
}

export const seedTotals = (rows: readonly SeedPassRow[]): SeedTotals => ({
  inserted: rows.reduce((sum, row) => sum + row.inserted, 0),
  updated: rows.reduce((sum, row) => sum + row.updated, 0),
  skipped: rows.reduce((sum, row) => sum + row.skipped, 0),
  failed: rows.filter((row) => row.status === 'failed').length,
});

/**
 * Slowest first, in both renderers: a seed run that got slow is diagnosed by which FILE took the
 * time, and a list in run order buries that under whatever happens to be alphabetically first.
 */
const slowestFirst = (rows: readonly SeedPassRow[]): readonly SeedPassRow[] =>
  rows.toSorted((left, right) => right.ms - left.ms);

export const seedPassToJson = (rows: readonly SeedPassRow[]): JsonValue => ({
  seeds: slowestFirst(rows).map((row) => ({
    file: row.file,
    name: row.name,
    tier: row.tier,
    status: row.status,
    ms: row.ms,
    inserted: row.inserted,
    updated: row.updated,
    skipped: row.skipped,
  })),
  totals: { ...seedTotals(rows) },
});

export const renderSeedTable = (rows: readonly SeedPassRow[]): readonly string[] =>
  renderTable(
    ['seed', 'tier', 'status', 'ms', 'inserted', 'updated', 'skipped'],
    slowestFirst(rows).map((row) => [
      row.name,
      row.tier,
      row.status,
      String(row.ms),
      String(row.inserted),
      String(row.updated),
      String(row.skipped),
    ]),
  );
