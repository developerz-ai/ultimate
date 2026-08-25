// `x db gen|migrate|reset|seed|studio|branch|backfill` — everything that touches the database. One
// subcommand per line and no fall-through: a word this file does not know is refused, never
// re-read as an argument to the last branch. `branch` itself is `cmd-db-branch.ts`.
//
// Every subcommand here runs `@ultimat3/db`'s own engine, which is the engine `ROLE=migrate` runs
// (`serve.ts`): one `x_migrations` ledger, one checksum rule, one advisory lock, from a laptop to
// a release phase. Until 1.2.0 these shelled out to `bunx drizzle-kit` — a second engine with a
// second journal, declared in no `package.json` and fetched unpinned at run time.

// `node:fs/promises` for `rm` — `Bun.file().delete()` takes one file, and `x db reset` removes a
// directory tree. `node:path` for `join` — Bun exposes no path joiner.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveEnvironment } from '@ultimat3/core';
import { type DriftReport, driftError, withTransaction } from '@ultimat3/db';
import { postgresDriver } from '@ultimat3/entity';
import { requireAppRoot } from './app-root';
import { runBackfillCommand } from './cmd-db-backfill';
import { runBranchCommand } from './cmd-db-branch';
import { plannedSubcommand } from './cmd-planned';
import type { CliCommand, CommandContext } from './command';
import { BRANCH_SUBCOMMANDS } from './db-branch';
import { stepFinding } from './db-finding';
import { generateAppMigration, unrenderedJson, unrenderedLines } from './db-generate';
import type { SeedPassRow } from './db-seed';
import {
  discoverSeeds,
  parseSeedTierFlag,
  renderSeedTable,
  runSeeds,
  seedPassToJson,
  seedTotals,
  selectSeeds,
} from './db-seed';
import { resolveServices } from './dev-services';
import { CliNotImplementedError, MissingSubcommandError, UnknownCommandError } from './errors';
import { withJobDriver } from './jobs-driver';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom } from './output';
import { flagBool, flagString } from './parse';
import { runMigrations } from './serve';

export const DB_SUBCOMMANDS = [
  'gen',
  'migrate',
  'reset',
  'seed',
  'studio',
  'branch',
  'backfill',
] as const;

export const dbCommand: CliCommand = {
  spec: {
    name: 'db',
    summary: 'gen, migrate, reset, seed, studio, branch, backfill',
    usage:
      'x db gen "add publish_at" | migrate | reset | seed [<name>] [--tier reference|dev] [--dry-run] | studio | branch ls | branch create <name> | branch drop <name> | backfill [<name>|--all] [--write] [--force] | backfill --pending | backfill --list [--name n] [--status s] [--limit n]',
    requiresApp: true,
    subcommands: DB_SUBCOMMANDS,
    // Declared from the constant `runBranchCommand` validates against, never a second literal: it
    // is what lets the `errors` step resolve `x db branch ls` — a fix line three shipped errors
    // hand out, which read `ls` as a branch name and cloned a database until 1.2.x.
    subcommandPositionals: { branch: BRANCH_SUBCOMMANDS },
    // Each flag whose summary begins `<subcommand>:` declares that scope, and the parser refuses
    // it anywhere else: `x db gen --dry-run` used to parse, reach `runGen` and WRITE the
    // migration. `cmd-db.test.ts` pins summary and scope to the same fact.
    flags: [
      {
        name: 'name',
        type: 'string',
        summary: 'migration, branch or seed name, or backfill to filter',
      },
      {
        name: 'tier',
        type: 'string',
        summary: 'seed: which tier to run — reference or dev; also ULTIMATE_SEED_TIER',
        subcommands: ['seed'],
      },
      {
        name: 'dry-run',
        type: 'boolean',
        summary: 'seed: report what each seed would write, and write nothing',
        subcommands: ['seed'],
      },
      {
        name: 'list',
        type: 'boolean',
        summary: 'backfill: print the x_backfills ledger',
        subcommands: ['backfill'],
      },
      {
        name: 'pending',
        type: 'boolean',
        summary: 'backfill: declared minus completed; non-zero exit when anything is unswept',
        subcommands: ['backfill'],
      },
      {
        name: 'all',
        type: 'boolean',
        summary: 'backfill: every pending sweep, isolated per name',
        subcommands: ['backfill'],
      },
      {
        name: 'write',
        type: 'boolean',
        summary: 'backfill: enqueue the pass; dry run without it',
        subcommands: ['backfill'],
      },
      {
        name: 'force',
        type: 'boolean',
        summary: 'backfill: sweep a name the ledger records as completed, as a NEW ledger row',
        subcommands: ['backfill'],
      },
      {
        name: 'status',
        type: 'string',
        summary: 'backfill: filter by running, completed or failed',
        subcommands: ['backfill'],
      },
      {
        name: 'limit',
        type: 'string',
        summary: 'backfill: max ledger rows to return',
        subcommands: ['backfill'],
      },
      // Declared because `X_MIGRATION_IRREVERSIBLE`'s own fix line names it. A `fix:` is copied
      // and run verbatim, so a flag the parser refuses would make the error unfollowable.
      {
        name: 'allow-destructive',
        type: 'boolean',
        summary: 'let x db gen emit a drop whose down cannot restore the rows',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('db', ctx.cwd).dir;
    // No default, and no `?? 'migrate'` here either: `gen` writes a migration file and `reset`
    // drops the database, so "whatever the caller left out" is not a safe guess for any of the six.
    // The parser refuses a bare `x db`; this covers a `ParsedArgs` built by hand.
    const sub = ctx.args.subcommand;
    if (sub === undefined)
      throw new MissingSubcommandError({ command: 'db', known: DB_SUBCOMMANDS });
    const argument = ctx.args.positionals[0] ?? flagString(ctx.args, 'name');

    if (sub === 'gen') return runGen(ctx, root, argument ?? 'change');
    if (sub === 'migrate') return runMigrate(ctx, root, msg('cli.db.migrate.applied'));
    if (sub === 'reset') return runReset(ctx, root);
    if (sub === 'seed') return runSeed(ctx, root);
    if (sub === 'studio') throw plannedSubcommand('db', 'studio');
    if (sub === 'backfill') return runBackfillCommand(ctx, root);
    if (sub === 'branch') return runBranchCommand(ctx, root);

    // Never a fall-through. This used to end `return runBranch(ctx, root, argument ?? 'preview')`,
    // so ANY subcommand the parser had not already refused was reinterpreted as a branch NAME and
    // cloned a database out of it. A word this command does not know is a refusal, not a guess.
    throw new UnknownCommandError({
      path: `db ${sub}`,
      known: DB_SUBCOMMANDS,
      // Help, and not the nearest name: `studio` is planned, and `branch`/`backfill` both need a
      // word this refusal does not have — a suggestion that refuses in turn is not a fix.
      suggestion: 'help db',
    });
  },
};

/**
 * Source in, files out — no database is opened, so this answers the same in CI and on a laptop
 * with nothing running. A diff that finds nothing writes no MIGRATION and still exits 0: "no
 * change" is an answer, and an empty migration would take a ledger row and a checksum forever. It
 * may still write the `.hash` sidecar `x verify`'s `drift` step reads, which is what makes
 * `X_DB_DRIFT`'s `fix:` — this command — a real instruction rather than a no-op.
 *
 * So there are THREE answers, not two, and `--json` carries `outcome` on every one: collapsing
 * `hash-recorded` into either neighbour tells the machine reading this output that a migration
 * exists when none does, or that nothing was written when the sidecar was.
 */
async function runGen(ctx: CommandContext, root: string, name: string): Promise<CommandResult> {
  let generated: Awaited<ReturnType<typeof generateAppMigration>>;
  try {
    generated = await generateAppMigration(root, {
      name,
      allowDestructive: flagBool(ctx.args, 'allow-destructive'),
    });
  } catch (error) {
    return {
      ok: false,
      command: 'db',
      summary: msg('cli.db.gen.failed'),
      findings: [stepFinding(error, 'X_DB_GEN_FAILED')],
    };
  }
  // Loud on BOTH branches, and never an exit code. `x db gen` is the `fix:` on `X_DB_DRIFT` and on
  // four other shipped errors, so a run that exits 1 whenever the description carries a default
  // this build cannot project would make every one of those instructions unfollowable — the
  // `x i18n add fr` failure, repeated. The count is the verdict; the gate's own `drift` step is
  // where a red belongs, and it reads the same list to decide that `x db gen` is not the fix.
  const lost = unrenderedLines(generated.unrendered);
  const migration = generated.migration;
  if (migration === undefined) {
    return {
      ok: generated.findings.length === 0,
      command: 'db',
      // The sidecar path, never a bare id: `hash-recorded` writes exactly one, and it is the file
      // the `drift` step reads back.
      summary:
        generated.outcome === 'hash-recorded'
          ? msg('cli.db.gen.recorded', { file: generated.files[0] ?? '' })
          : msg('cli.db.gen.unchanged'),
      findings: generated.findings,
      // `files` is what this command WROTE, so the empty array here was a false claim.
      lines: [...generated.files.map((file) => `  ${file}`), ...lost],
      data: {
        outcome: generated.outcome,
        migration: null,
        files: [...generated.files],
        schemaHash: generated.schemaHash ?? null,
        unrendered: unrenderedJson(generated.unrendered),
      },
    };
  }
  return {
    ok: true,
    command: 'db',
    summary: msg('cli.db.gen.written', { id: migration.id }),
    lines: [...generated.files.map((file) => `  ${file}`), ...lost],
    data: {
      outcome: generated.outcome,
      migration: migration.id,
      name: migration.name,
      files: [...generated.files],
      schemaHash: generated.schemaHash ?? null,
      unrendered: unrenderedJson(generated.unrendered),
    },
  };
}

/**
 * The post-migrate report, rendered. Through `driftError` rather than a second literal: the
 * three-line `X_DB_DRIFT` output is pinned by the framework contract, and this command must not be
 * where a copy of it drifts from the one `x verify` prints.
 */
export const driftFindings = (report: DriftReport): readonly Finding[] =>
  report.differences.map((difference) => findingFrom(driftError(difference)));

/**
 * `runMigrations` is `serve.ts`'s, unchanged and unwrapped: the developer applying a migration and
 * the release-phase container applying it run the same function, over the same file list, through
 * the same ledger, and verify the same post-condition — the live schema against that ledger. A
 * database that migrated cleanly and still disagrees is the failure this command exists to
 * surface, and only a check that opened the connection can see it.
 *
 * The *source* half — an entity edited with no migration generated — is `x verify`'s `drift` step
 * (`checkSourceDrift`) and is deliberately not repeated here: two reporters of one condition is the
 * duplication this package's own rule forbids, and that one needs no database at all.
 */
async function runMigrate(
  ctx: CommandContext,
  root: string,
  summary: string,
): Promise<CommandResult> {
  try {
    const migrated = await runMigrations({ root, env: ctx.env });
    const report = migrated.report;
    return {
      ok: migrated.drift.ok,
      command: 'db',
      summary,
      findings: driftFindings(migrated.drift),
      data: {
        applied: report.applied.map((entry) => entry.id),
        skipped: report.skipped.length,
        appVersion: report.appVersion,
        durationMs: report.durationMs,
      },
    };
  } catch (error) {
    return {
      ok: false,
      command: 'db',
      summary: msg('cli.db.migrate.failed'),
      findings: [stepFinding(error, 'X_DB_MIGRATE_FAILED')],
    };
  }
}

/**
 * Embedded only: `rm -rf` against a database this process does not own is not a reset, it is an
 * outage. The data directory goes before the migrator starts, so the run that follows is a fresh
 * database with an empty ledger rather than a re-apply over a live one.
 */
async function runReset(ctx: CommandContext, root: string): Promise<CommandResult> {
  const services = resolveServices(root, ctx.env);
  if (services.db.mode === 'external') {
    throw new CliNotImplementedError({
      feature: 'x db reset against an external Postgres',
      fix: 'drop and recreate the database yourself, then run: x db migrate',
    });
  }
  await rm(join(services.stateDir, 'pgdata'), { recursive: true, force: true });
  return runMigrate(ctx, root, msg('cli.db.reset.done'));
}

/**
 * `x db seed [<name>]` — the fixture graph, applied and replayable.
 *
 * The environment is resolved BEFORE anything is imported or connected: a run this environment does
 * not take must refuse without having opened a connection to the database it was refusing to write
 * to. `selectSeeds` asks the same question a second time, on the seeds themselves, because seeding
 * is the one irreversible thing this command does (`db-seed.ts`).
 *
 * `withJobDriver` is the boot, though nothing here claims a job: it is the CLI's one answer to
 * "which database is this command talking to", and it also puts a real queue behind any
 * `handle.enqueue()` a seeded write triggers. A second boot path would be a second answer.
 */
async function runSeed(ctx: CommandContext, root: string): Promise<CommandResult> {
  const environment = resolveEnvironment({ env: ctx.env });
  const requested = parseSeedTierFlag(
    flagString(ctx.args, 'tier') ?? ctx.env['ULTIMATE_SEED_TIER'],
  );
  const name = ctx.args.positionals[0] ?? flagString(ctx.args, 'name');
  const dryRun = flagBool(ctx.args, 'dry-run');
  const discovery = await discoverSeeds(root);
  const chosen = selectSeeds({
    discovered: discovery.seeds,
    ...(name === undefined ? {} : { name }),
    environment,
    requested,
  });
  if (chosen.length === 0) {
    return {
      ok: true,
      command: 'db',
      summary: msg('cli.db.seed.none'),
      findings: discovery.findings,
      data: seedPassToJson([]),
    };
  }
  return withJobDriver(root, ctx, async () => {
    const rows = await runSeeds({
      seeds: chosen,
      driver: postgresDriver(),
      dryRun,
      env: ctx.env,
      // One transaction per seed, so a seed that throws takes only its own rows with it.
      transaction: (work) => withTransaction(() => work()),
    });
    return seedPassResult(rows, dryRun, discovery.findings);
  });
}

function seedPassResult(
  rows: readonly SeedPassRow[],
  dryRun: boolean,
  findings: readonly Finding[],
): CommandResult {
  const totals = seedTotals(rows);
  const failures = rows.flatMap((row) => (row.finding === null ? [] : [row.finding]));
  return {
    ok: failures.length === 0 && findings.length === 0,
    command: 'db',
    summary:
      totals.failed > 0
        ? msg('cli.db.seed.failed', { failed: totals.failed, count: rows.length })
        : dryRun
          ? msg('cli.db.seed.dryRun', { count: rows.length })
          : msg('cli.db.seed.done', {
              count: rows.length,
              inserted: totals.inserted,
              updated: totals.updated,
              skipped: totals.skipped,
            }),
    findings: [...failures, ...findings],
    lines: renderSeedTable(rows).map((line) => `  ${line}`),
    data: seedPassToJson(rows),
  };
}
