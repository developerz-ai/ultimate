// What a branch database IS, for the two databases `x db` can be pointed at: the closed set of
// verbs, the name a branch takes on disk or in `pg_database`, and list/create/drop for each mode.
// Plain inputs, plain rows — no `ParsedArgs`, no `CommandResult` — so every rule here is testable
// against a temp directory and a recording client, and `cmd-db-branch.ts` owns only the wiring.

// `node:fs/promises` for `readdir`/`rm`/`stat` — Bun exposes no directory listing, no recursive
// delete and no birthtime. `node:path` for the joiner Bun also does not have.
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DbClient } from '@ultimat3/db';
import {
  assertBranchName,
  branchPglite,
  createBranch,
  currentDatabase,
  dropBranch,
  listBranches,
  pgliteBranchDir,
  pgliteDataDir,
} from '@ultimat3/db';

/**
 * The closed set `x db branch` takes as its first positional, and the reason a branch name can no
 * longer be mistaken for one. `x db branch <name>` read its argument as a name, so `x db branch
 * ls` — a fix line three shipped errors hand out — cloned a database called `ls`.
 *
 * `reap` is deliberately absent: a nightly sweep is a `task` (`reapBranches` from `@ultimat3/db`),
 * and a CLI verb for it would be a second path to one job with a max-age nobody can default.
 */
export const BRANCH_SUBCOMMANDS = ['ls', 'create', 'drop'] as const;

export type BranchSubcommand = (typeof BRANCH_SUBCOMMANDS)[number];

export const isBranchSubcommand = (word: string): word is BranchSubcommand =>
  (BRANCH_SUBCOMMANDS as readonly string[]).includes(word);

/**
 * `@ultimat3/db` owns what a branch name may be (`[a-z0-9_-]+`, validated before it reaches a path
 * or a `CREATE DATABASE`). Asked through its own assertion rather than re-spelled here, because a
 * second copy of that regex is a second answer to "is this safe to interpolate".
 */
export function isBranchName(value: string): boolean {
  try {
    assertBranchName(value);
    return true;
  } catch {
    return false;
  }
}

/** Where a branch's app answers once something serves it — the preview half of the design. */
export const previewUrl = (branch: string, port: number): string =>
  `http://${branch}.localhost:${port}`;

/** One branch, whichever database it lives in. */
export interface BranchRow {
  readonly name: string;
  /** Where it lives: a database name, or a PGlite data directory. Point `DATABASE_URL` at it. */
  readonly location: string;
  /** `null` where nothing recorded one — the embedded copy keeps no creation record of its own. */
  readonly createdAt: string | null;
  /** `null` where measuring it would cost a full walk of the branch. */
  readonly sizeBytes: number | null;
}

/** `x db branch create <name>` on a real Postgres clones into `<source>_branch_<name>`. */
export function branchDatabaseName(source: string, branch: string): string {
  return `${source}_branch_${branch.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * The reverse, and the ONE reader of it: `mcp-db-target.ts` asks the same question to decide
 * whether `db.migrate` is aimed at a private database. A branch created straight through
 * `createBranch()` carries the marker without the naming convention, so an unmatched name is
 * answered `null` and the caller falls back to the database's own name.
 */
export const branchNameOf = (database: string): string | null =>
  /_branch_(.+)$/.exec(database)?.[1] ?? null;

/**
 * The embedded peer: `branchPglite` copies `<dir>` to `<dir>-<name>`, so the branch name is the
 * suffix. `pgliteBranchDir` is the forward rule and this is its inverse — written once, because
 * `x db branch ls` and the MCP host's branch check must agree about what a branch directory is.
 */
export function pgliteBranchName(dir: string, source: string): string | null {
  return dir.startsWith(`${source}-`) ? dir.slice(source.length + 1) : null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory's own creation time, which is when the copy landed. `branchPglite` returns a
 * `createdAt` and persists it nowhere, so this is the only record there is — and filesystems that
 * keep none report 0, which is answered as "unknown" rather than as 1970.
 */
async function createdAtOf(path: string): Promise<string | null> {
  try {
    const birth = (await stat(path)).birthtimeMs;
    return birth > 0 ? new Date(birth).toISOString() : null;
  } catch {
    return null;
  }
}

export async function listPgliteBranches(url: string): Promise<readonly BranchRow[]> {
  const source = pgliteDataDir(url);
  const parent = dirname(source);
  let entries: readonly string[];
  try {
    entries = await readdir(parent);
  } catch {
    // Nothing has run against this app yet. "No branches" is the honest answer to the question.
    return [];
  }
  const rows: BranchRow[] = [];
  for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
    const name = pgliteBranchName(entry, basename(source));
    if (name === null) continue;
    const location = join(parent, entry);
    if (!(await isDirectory(location))) continue;
    rows.push({ name, location, createdAt: await createdAtOf(location), sizeBytes: null });
  }
  return rows;
}

/** Where a branch WOULD live — what a refusal names, so it can be checked rather than believed. */
export const pgliteBranchLocation = (url: string, branch: string): string =>
  pgliteBranchDir(pgliteDataDir(url), branch);

export async function createPgliteBranch(url: string, branch: string): Promise<BranchRow> {
  const info = await branchPglite(branch, { from: url });
  return {
    name: info.name,
    location: info.dataDir,
    createdAt: info.createdAt,
    sizeBytes: info.sizeBytes,
  };
}

/**
 * Answers whether there was a branch there, exactly as `dropBranch` does. The name is asserted
 * before it reaches a path: it is spliced into a directory name, so an unvalidated one is
 * traversal rather than a typo — and `pgliteBranchDir` can never resolve to the source itself.
 */
export async function dropPgliteBranch(url: string, branch: string): Promise<boolean> {
  assertBranchName(branch);
  const dir = pgliteBranchDir(pgliteDataDir(url), branch);
  if (!(await isDirectory(dir))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Only databases carrying `createBranch`'s own marker comment. A database this listing does not
 * name is one nothing here created, which is what makes "you may only drop what `ls` shows" a
 * guard rather than a courtesy.
 */
export async function listExternalBranches(client: DbClient): Promise<readonly BranchRow[]> {
  const branches = await listBranches({ client });
  return branches.map((branch) => ({
    name: branchNameOf(branch.name) ?? branch.name,
    location: branch.name,
    createdAt: branch.createdAt,
    sizeBytes: branch.sizeBytes,
  }));
}

/**
 * Through `createBranch`, never a hand-written `CREATE DATABASE`: it validates the name, refuses a
 * database that already exists with `X_BRANCH_EXISTS`, and writes the marker comment that makes
 * the clone visible to `ls`. The CLI shelled out to `psql` until now and wrote no marker at all,
 * so every branch it made was invisible to the only lister the framework has.
 */
export async function createExternalBranch(client: DbClient, branch: string): Promise<BranchRow> {
  const source = await currentDatabase(client);
  const database = branchDatabaseName(source, branch);
  const info = await createBranch(database, { client, base: source });
  return {
    name: branchNameOf(database) ?? database,
    location: database,
    createdAt: info.createdAt,
    // `createBranch` reports 0 for a database it has not measured; unknown is the truthful word.
    sizeBytes: null,
  };
}

/** `force`, because a branch exists to be thrown away and its own sessions must not outvote that. */
export async function dropExternalBranch(client: DbClient, branch: string): Promise<boolean> {
  const source = await currentDatabase(client);
  return dropBranch(branchDatabaseName(source, branch), { client, force: true });
}
