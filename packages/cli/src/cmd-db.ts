// `x db gen|migrate|reset|studio|branch` — everything that touches the database, including the
// branch DB that makes destructive work safe. An agent that can clone the database in a second
// can migrate, seed and break things without a human deciding whether to let it.
//
// Every subcommand here runs `@ultimat3/db`'s own engine, which is the engine `ROLE=migrate` runs
// (`serve.ts`): one `x_migrations` ledger, one checksum rule, one advisory lock, from a laptop to
// a release phase. Until 1.2.0 these shelled out to `bunx drizzle-kit` — a second engine with a
// second journal, declared in no `package.json` and fetched unpinned at run time.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { branchPglite } from '@ultimat3/db';
import { requireAppRoot } from './app-root';
import { plannedSubcommand } from './cmd-planned';
import type { CliCommand, CommandContext } from './command';
import { generateAppMigration } from './db-generate';
import { resolveServices } from './dev-services';
import { checkDrift } from './drift';
import { CliNotImplementedError } from './errors';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom, isUltimateErrorShape } from './output';
import { flagBool, flagString } from './parse';
import { runMigrations } from './serve';

export const DB_SUBCOMMANDS = ['gen', 'migrate', 'reset', 'studio', 'branch'] as const;

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
    summary: 'gen, migrate, reset, studio, branch',
    usage: 'x db gen "add publish_at" | migrate | reset | studio | branch <name>',
    requiresApp: true,
    subcommands: DB_SUBCOMMANDS,
    flags: [
      { name: 'name', type: 'string', summary: 'migration or branch name' },
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
 * `runMigrations` is `serve.ts`'s, unchanged and unwrapped: the developer applying a migration and
 * the release-phase container applying it run the same function, over the same file list, through
 * the same ledger. Drift is the post-condition on both — a schema that migrated cleanly and still
 * disagrees with the entities is the failure this command exists to surface.
 */
async function runMigrate(
  ctx: CommandContext,
  root: string,
  summary: string,
): Promise<CommandResult> {
  try {
    const migrated = await runMigrations({ root, env: ctx.env });
    const drift = await checkDrift(root);
    const report = migrated.report;
    return {
      ok: drift.length === 0,
      command: 'db',
      summary,
      findings: drift,
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
