// `x db gen|migrate|reset|studio|branch|backfill` — everything that touches the database,
// including the branch DB that makes destructive work safe. An agent that can clone the database
// in a second can migrate, seed and break things without a human deciding whether to let it.
//
// Every subcommand here runs `@ultimat3/db`'s own engine, which is the engine `ROLE=migrate` runs
// (`serve.ts`): one `x_migrations` ledger, one checksum rule, one advisory lock, from a laptop to
// a release phase. Until 1.2.0 these shelled out to `bunx drizzle-kit` — a second engine with a
// second journal, declared in no `package.json` and fetched unpinned at run time.

// `node:fs/promises` for `rm` — `Bun.file().delete()` takes one file, and `x db reset` removes a
// directory tree. `node:path` for `join` — Bun exposes no path joiner.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { branchPglite, type DriftReport, driftError } from '@ultimat3/db';
import { requireAppRoot } from './app-root';
import { plannedSubcommand } from './cmd-planned';
import type { CliCommand, CommandContext } from './command';
import { listBackfills, renderBackfillTable } from './db-backfill';
import { generateAppMigration } from './db-generate';
import { resolveServices } from './dev-services';
import { BadFlagError, CliNotImplementedError } from './errors';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { withJobDriver } from './jobs-driver';
import { backfillToJson } from './jobs-json';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom, isUltimateErrorShape } from './output';
import { flagBool, flagString } from './parse';
import { runMigrations } from './serve';

export const DB_SUBCOMMANDS = ['gen', 'migrate', 'reset', 'studio', 'branch', 'backfill'] as const;

const failure = (result: ExecResult, code: string, fix: string): Finding => ({
  code,
  cause: `${result.command.join(' ')} exited ${result.code}: ${execOutput(result).slice(0, 400)}`,
  fix,
  docs: `https://ultimate.dev/errors/${code}`,
});

/**
 * The engine names its own failures — `X_MIGRATION_CONFLICT` carries the ledger row that disagrees
 * and `X_MIGRATION_IRREVERSIBLE` carries the exact `--allow-destructive` line to rerun — so those
 * reach the caller verbatim. `X_DB_GEN_FAILED` / `X_DB_MIGRATE_FAILED` are what is left: the step
 * failed for a reason no framework error claimed, and the raw message is all there is to report.
 */
const stepFinding = (error: unknown, code: string): Finding =>
  isUltimateErrorShape(error)
    ? findingFrom(error)
    : {
        code,
        cause: error instanceof Error ? error.message : String(error),
        fix: 'x doctor --json',
        docs: `https://ultimate.dev/errors/${code}`,
      };

/** `x db branch <name>` on a real Postgres: copy-on-write clone, cheap and disposable. */
export function branchSql(source: string, branch: string): string {
  return `CREATE DATABASE "${branch}" TEMPLATE "${source}"`;
}

export function branchDatabaseName(source: string, branch: string): string {
  return `${source}_branch_${branch.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export const previewUrl = (branch: string, port: number): string =>
  `http://${branch}.localhost:${port}`;

async function runBranch(
  ctx: CommandContext,
  root: string,
  branch: string,
): Promise<CommandResult> {
  const services = resolveServices(root, ctx.env);
  const port = Number.parseInt(ctx.env['PORT'] ?? '3000', 10);
  const url = previewUrl(branch, port);
  if (services.db.mode === 'embedded') {
    // @ultimat3/db owns embedded branching, name validation and the on-disk layout. Shelling out
    // to `cp` here was a second implementation of all three — and `--reflink` is a GNU-only flag.
    try {
      const info = await branchPglite(branch, { from: services.db.url });
      return {
        ok: true,
        command: 'db',
        summary: msg('cli.db.branch.ready', { name: branch }),
        data: { branch, database: info.dataDir, preview: url, mode: 'embedded' },
      };
    } catch (error) {
      return {
        ok: false,
        command: 'db',
        summary: msg('cli.usage'),
        findings: [findingFrom(error)],
      };
    }
  }
  const source = services.db.url.split('/').at(-1) ?? 'postgres';
  const database = branchDatabaseName(source, branch);
  const psql = await ctx.runner(['psql', services.db.url, '-c', branchSql(source, database)], {
    cwd: root,
  });
  if (!psql.ok) {
    return {
      ok: false,
      command: 'db',
      summary: msg('cli.usage'),
      findings: [
        failure(
          psql,
          'X_DB_BRANCH_FAILED',
          `close open connections to "${source}" (a TEMPLATE clone needs none), then retry`,
        ),
      ],
    };
  }
  return {
    ok: true,
    command: 'db',
    summary: msg('cli.db.branch.ready', { name: branch }),
    data: { branch, database, preview: url, mode: 'external' },
  };
}

export const dbCommand: CliCommand = {
  spec: {
    name: 'db',
    summary: 'gen, migrate, reset, studio, branch, backfill',
    usage:
      'x db gen "add publish_at" | migrate | reset | studio | branch <name> | backfill --list [--name n] [--status s] [--limit n]',
    requiresApp: true,
    subcommands: DB_SUBCOMMANDS,
    flags: [
      { name: 'name', type: 'string', summary: 'migration or branch name, or backfill to filter' },
      { name: 'list', type: 'boolean', summary: 'backfill: print the x_backfills ledger' },
      {
        name: 'status',
        type: 'string',
        summary: 'backfill: filter by running, completed or failed',
      },
      { name: 'limit', type: 'string', summary: 'backfill: max ledger rows to return' },
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
    const sub = ctx.args.subcommand ?? 'migrate';
    const argument = ctx.args.positionals[0] ?? flagString(ctx.args, 'name');

    if (sub === 'gen') return runGen(ctx, root, argument ?? 'change');
    if (sub === 'migrate') return runMigrate(ctx, root, msg('cli.db.migrate.applied'));
    if (sub === 'reset') return runReset(ctx, root);
    if (sub === 'studio') throw plannedSubcommand('db', 'studio');
    if (sub === 'backfill') return runBackfill(ctx, root);

    return runBranch(ctx, root, argument ?? 'preview');
  },
};

/**
 * Source in, files out — no database is opened, so this answers the same in CI and on a laptop
 * with nothing running. A diff that finds nothing writes nothing and still exits 0: "no change" is
 * an answer, and an empty migration would take a ledger row and a checksum forever.
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
  const migration = generated.migration;
  if (migration === undefined) {
    return {
      ok: generated.findings.length === 0,
      command: 'db',
      summary: msg('cli.db.gen.unchanged'),
      findings: generated.findings,
      data: { migration: null, files: [] },
    };
  }
  return {
    ok: true,
    command: 'db',
    summary: msg('cli.db.gen.written', { id: migration.id }),
    lines: generated.files.map((file) => `  ${file}`),
    data: {
      migration: migration.id,
      name: migration.name,
      files: [...generated.files],
      schemaHash: generated.schemaHash ?? null,
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
 * `--list` is the only shape this subcommand ships, and its absence is refused rather than
 * defaulted: `x db backfill <name>` will one day RUN a pass, so a bare `x db backfill` that quietly
 * printed the ledger would be a second spelling of one command today and a silent no-op the day
 * the runner lands. Not `X_NOT_IMPLEMENTED` either — that is for a subcommand that ships nothing,
 * and this one ships the ledger. The reason names the invocation that works, verbatim.
 *
 * An empty ledger is `ok: true`. "Nothing has swept this database yet" is an answer to the
 * question asked, and a command that failed over it would be unrunnable on a fresh app.
 */
async function runBackfill(ctx: CommandContext, root: string): Promise<CommandResult> {
  if (!flagBool(ctx.args, 'list')) {
    throw new BadFlagError({
      flag: 'list',
      command: 'db',
      reason: 'x db backfill reports the ledger and runs nothing yet: x db backfill --list',
      fix: 'x db backfill --list',
    });
  }
  return withJobDriver(root, ctx, async (driver) => {
    const rows = await listBackfills(driver, {
      name: flagString(ctx.args, 'name'),
      status: flagString(ctx.args, 'status'),
      limit: flagString(ctx.args, 'limit'),
    });
    return {
      ok: true,
      command: 'db',
      summary:
        rows.length === 0
          ? msg('cli.db.backfill.empty')
          : msg('cli.db.backfill.listed', { count: rows.length }),
      lines: rows.length === 0 ? [] : renderBackfillTable(rows).map((line) => `  ${line}`),
      data: rows.map(backfillToJson),
    };
  });
}
