// `x db branch ls|create|drop` — the wiring alone: which verb, which database, which refusal.
// A VERB is required and comes from a closed set, so a branch name can never be read as one:
// `x db branch ls` used to clone a database called `ls`, because the argument was the name.
// The facts (what a branch is, per mode) are `db-branch.ts`; the client lifetime is here.

import { ERROR_DOCS_URL, nearestName } from '@ultimat3/core';
import { createPostgresClient, type DbClient } from '@ultimat3/db';
import type { CommandContext } from './command';
import type { BranchRow } from './db-branch';
import {
  BRANCH_SUBCOMMANDS,
  branchDatabaseName,
  createExternalBranch,
  createPgliteBranch,
  databaseNameOf,
  dropExternalBranch,
  dropPgliteBranch,
  isBranchName,
  isBranchSubcommand,
  listExternalBranches,
  listPgliteBranches,
  pgliteBranchLocation,
  previewUrl,
} from './db-branch';
import { stepFinding } from './db-finding';
import type { DevServices } from './dev-services';
import { resolveServices } from './dev-services';
import { MissingPositionalError, UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagString } from './parse';
import { portFromEnv } from './serve';
import { renderTable } from './table';

/**
 * Always runnable, always the next thing a caller needs: what branches there are. Spelled twice
 * because `UnknownCommandError` prefixes its `suggestion` with `x ` and `MissingPositionalError`
 * takes a whole invocation — one of them handed back `x x db branch ls --json`.
 */
const LIST_ARGV = 'db branch ls --json';
const LIST_FIX = `x ${LIST_ARGV}`;

/**
 * A near miss on a three-verb set is a typo; anything else is the bare-name form this replaced —
 * `x db branch feat-new-billing` used to CREATE, so the refusal hands the caller's own name back
 * inside the command that still does it. Every answer here is a complete, runnable invocation,
 * `x` excluded — the error class adds it.
 */
function branchRetry(word: string, name: string | undefined): string {
  const near = nearestName(word, [...BRANCH_SUBCOMMANDS]);
  if (near !== undefined) return name === undefined ? LIST_ARGV : `db branch ${near} ${name}`;
  return isBranchName(word) ? `db branch create ${word}` : LIST_ARGV;
}

/**
 * `x db branch` against an external Postgres, on ONE connection.
 *
 * `role: 'migrate'` is the profile, not a decoration: it is `max: 1` with no statement timeout, and
 * both halves are load-bearing. `CREATE DATABASE ... TEMPLATE` is refused while any OTHER session
 * is connected to the template, so a pool that spread three statements over three connections
 * would leave two idle sessions holding the source open against itself; and cloning a real
 * database routinely outlives the 10s a `web` profile allows.
 */
async function withBranchClient<T>(url: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = createPostgresClient({ url, role: 'migrate', applicationName: 'x-db-branch' });
  try {
    return await fn(client);
  } finally {
    // Or the CLI exits holding a connection, and the next command waits for it to time out.
    await client.close();
  }
}

const branchesOf = (services: DevServices): Promise<readonly BranchRow[]> =>
  services.db.mode === 'embedded'
    ? listPgliteBranches(services.db.url)
    : withBranchClient(services.db.url, listExternalBranches);

const failure = (summary: string, finding: Finding): CommandResult => ({
  ok: false,
  command: 'db',
  summary,
  findings: [finding],
});

export async function runBranchCommand(ctx: CommandContext, root: string): Promise<CommandResult> {
  const verb = ctx.args.positionals[0];
  if (verb === undefined) {
    throw new MissingPositionalError({
      command: 'db branch',
      positional: BRANCH_SUBCOMMANDS.join('|'),
      example: LIST_FIX,
    });
  }
  const name = ctx.args.positionals[1] ?? flagString(ctx.args, 'name');
  if (!isBranchSubcommand(verb)) {
    throw new UnknownCommandError({
      path: `db branch ${verb}`,
      known: BRANCH_SUBCOMMANDS,
      suggestion: branchRetry(verb, name),
    });
  }
  const services = resolveServices(root, ctx.env);
  if (verb === 'ls') return runList(services);
  if (name === undefined) {
    throw new MissingPositionalError({
      command: `db branch ${verb}`,
      positional: 'name',
      example: `x db branch ${verb} feature-x`,
    });
  }
  return verb === 'create' ? runCreate(ctx, services, name) : runDrop(services, name);
}

const row = (branch: BranchRow): readonly string[] => [
  branch.name,
  branch.location,
  branch.createdAt ?? msg('cli.db.branch.unknown'),
  branch.sizeBytes === null ? msg('cli.db.branch.unknown') : String(branch.sizeBytes),
];

async function runList(services: DevServices): Promise<CommandResult> {
  let branches: readonly BranchRow[];
  try {
    branches = await branchesOf(services);
  } catch (error) {
    return failure(msg('cli.db.branch.failed'), stepFinding(error, 'X_DB_BRANCH_FAILED'));
  }
  return {
    ok: true,
    command: 'db',
    summary:
      branches.length === 0
        ? msg('cli.db.branch.none')
        : msg('cli.db.branch.listed', { count: branches.length }),
    lines:
      branches.length === 0
        ? []
        : renderTable(['name', 'location', 'created-at', 'size-bytes'], branches.map(row)).map(
            (line) => `  ${line}`,
          ),
    data: branches.map((branch) => ({ ...branch })),
  };
}

async function runCreate(
  ctx: CommandContext,
  services: DevServices,
  name: string,
): Promise<CommandResult> {
  // `portFromEnv`, never a bare `Number.parseInt`: the latter reads `PORT=abc` as `NaN` and put
  // `http://feat.localhost:NaN` in `data.preview` — a machine-readable field naming no port.
  const port = portFromEnv(ctx.env);
  let branch: BranchRow;
  try {
    branch =
      services.db.mode === 'embedded'
        ? await createPgliteBranch(services.db.url, name)
        : await withBranchClient(services.db.url, (client) => createExternalBranch(client, name));
  } catch (error) {
    return failure(msg('cli.db.branch.failed'), stepFinding(error, 'X_DB_BRANCH_FAILED'));
  }
  return {
    ok: true,
    command: 'db',
    summary: msg('cli.db.branch.ready', { name: branch.name }),
    data: {
      branch: branch.name,
      database: branch.location,
      preview: previewUrl(branch.name, port),
      mode: services.db.mode,
    },
  };
}

/**
 * You may only drop what `ls` shows, and that is the whole guard — stronger than a confirmation
 * flag, because it is the typo that is impossible rather than the keystroke that is tedious. An
 * external branch is a database carrying `createBranch`'s marker comment AND this database's own
 * prefix, so neither the shared database this session is connected to nor another app's clone on
 * the same server is in the set; an embedded one is a `pgdata-<name>` directory, so `pgdata` itself
 * is not either. `@ultimat3/db`'s own `X_BRANCH_EXISTS` fix line is `x db branch drop <name>` with
 * no flag on it, so a flag here would break a shipped instruction.
 *
 * The check is not made here, and that is the point: `false` from either drop means "there was no
 * such branch", decided by the same call that deletes, on the same connection, one statement
 * earlier. A listing taken here and acted on below is two connections and a window wide enough to
 * hold a whole `create` — and the wiring layer is exactly where a guard must not live.
 */
async function runDrop(services: DevServices, name: string): Promise<CommandResult> {
  try {
    const dropped =
      services.db.mode === 'embedded'
        ? await dropPgliteBranch(services.db.url, name)
        : await withBranchClient(services.db.url, (client) => dropExternalBranch(client, name));
    if (!dropped) return notABranch(services, name);
    return {
      ok: true,
      command: 'db',
      summary: msg('cli.db.branch.dropped', { name }),
      data: { branch: name, mode: services.db.mode },
    };
  } catch (error) {
    return failure(msg('cli.db.branch.failed'), stepFinding(error, 'X_DB_BRANCH_FAILED'));
  }
}

/** Names what the drop WOULD have touched, so the refusal is checkable rather than assertable. */
function notABranch(services: DevServices, name: string): CommandResult {
  const target =
    services.db.mode === 'embedded'
      ? pgliteBranchLocation(services.db.url, name)
      : branchDatabaseName(databaseNameOf(services.db.url), name);
  return failure(msg('cli.db.branch.failed'), {
    code: 'X_DB_BRANCH_FAILED',
    cause: `"${name}" is not a branch of this database, so nothing was dropped (it would be ${target})`,
    fix: LIST_FIX,
    docs: ERROR_DOCS_URL,
  });
}
