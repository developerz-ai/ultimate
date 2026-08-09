// `x db gen|migrate|reset|studio|branch` — everything that touches the database, including the
// branch DB that makes destructive work safe. An agent that can clone the database in a second
// can migrate, seed and break things without a human deciding whether to let it.

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { branchPglite } from '@ultimat3/db';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { resolveServices } from './dev-services';
import { checkDrift, writeSchemaHash } from './drift';
import { CliNotImplementedError } from './errors';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom } from './output';
import { flagString } from './parse';

export const DB_SUBCOMMANDS = ['gen', 'migrate', 'reset', 'studio', 'branch'] as const;

const failure = (result: ExecResult, code: string, fix: string): Finding => ({
  code,
  cause: `${result.command.join(' ')} exited ${result.code}: ${execOutput(result).slice(0, 400)}`,
  fix,
  docs: `https://ultimate.dev/errors/${code}`,
});

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
    flags: [{ name: 'name', type: 'string', summary: 'migration or branch name' }],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('db', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'migrate';
    const argument = ctx.args.positionals[0] ?? flagString(ctx.args, 'name');

    if (sub === 'gen') {
      const name = (argument ?? 'change').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
      const result = await ctx.runner(['bunx', 'drizzle-kit', 'generate', '--name', name], {
        cwd: root,
      });
      if (!result.ok) {
        return {
          ok: false,
          command: 'db',
          summary: msg('cli.usage'),
          findings: [failure(result, 'X_DB_GEN_FAILED', 'x doctor --json')],
        };
      }
      const hash = await writeSchemaHash(root, latestMigration(root, name));
      return {
        ok: true,
        command: 'db',
        summary: `migration ${name} generated`,
        data: { migration: name, schemaHash: hash },
      };
    }

    if (sub === 'migrate') {
      const result = await ctx.runner(['bunx', 'drizzle-kit', 'migrate'], { cwd: root });
      const drift = await checkDrift(root);
      return {
        ok: result.ok && drift.length === 0,
        command: 'db',
        summary: result.ok ? 'migrations applied' : 'migration failed',
        findings: result.ok ? drift : [failure(result, 'X_DB_MIGRATE_FAILED', 'x db reset')],
        data: { applied: result.ok },
      };
    }

    if (sub === 'reset') {
      const services = resolveServices(root, ctx.env);
      if (services.db.mode === 'external') {
        throw new CliNotImplementedError({
          feature: 'x db reset against an external Postgres',
          fix: 'drop and recreate the database yourself, then run: x db migrate',
        });
      }
      await rm(join(services.stateDir, 'pgdata'), { recursive: true, force: true });
      const migrate = await ctx.runner(['bunx', 'drizzle-kit', 'migrate'], { cwd: root });
      return {
        ok: migrate.ok,
        command: 'db',
        summary: migrate.ok ? 'database reset and migrated' : 'reset failed',
        findings: migrate.ok ? [] : [failure(migrate, 'X_DB_MIGRATE_FAILED', 'x doctor --json')],
        data: { stateDir: services.stateDir },
      };
    }

    if (sub === 'studio') {
      const result = await ctx.runner(['bunx', 'drizzle-kit', 'studio'], { cwd: root });
      return {
        ok: result.ok,
        command: 'db',
        summary: result.ok ? 'studio exited' : 'studio failed to start',
        findings: result.ok ? [] : [failure(result, 'X_DB_STUDIO_FAILED', 'x doctor --json')],
      };
    }

    return runBranch(ctx, root, argument ?? 'preview');
  },
};

/** drizzle-kit names files `<index>_<name>.sql`; the hash sidecar has to match that base name. */
function latestMigration(root: string, name: string): string {
  const dir = join(root, 'packages', 'db', 'migrations');
  if (!existsSync(dir)) return `0000_${name}`;
  const matches = readdirSync(dir)
    .filter((file) => file.endsWith(`_${name}.sql`))
    .sort();
  const newest = matches.at(-1);
  return newest === undefined ? `0000_${name}` : newest.replace(/\.sql$/, '');
}
