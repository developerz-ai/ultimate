// Single responsibility: branching the embedded database. PGlite has no `CREATE DATABASE ...
// TEMPLATE`, so a branch is a copy of the data directory — which is why the branch name is
// validated before it ever reaches a path, and why the caller must have closed the source first:
// this copies files, it does not take a snapshot of a running instance.

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { systemClock } from '@ultimat3/core';
import type { BranchInfo } from './branch';
import { assertBranchName } from './branch';
import { branchExists, dbNotImplemented, dbUnavailable } from './errors';
import { PGLITE_MEMORY, pgliteDataDir } from './pglite';

export interface PgliteBranchOptions {
  /** The data directory to copy — what `x dev` is running against. A `pglite://` url also works. */
  readonly from: string;
  /** Where to put the branch. Defaults to `<from>-<branch>`, beside the source. */
  readonly to?: string | undefined;
  /** Replace an existing branch directory instead of refusing. */
  readonly force?: boolean | undefined;
  readonly now?: Date | undefined;
}

export interface PgliteBranchInfo extends BranchInfo {
  /** Hand this straight to `createPgliteClient({ dataDir })`. */
  readonly dataDir: string;
}

/** One place decides the on-disk layout, so `x db branch` and `x db reset` agree about it. */
export const pgliteBranchDir = (from: string, branch: string): string =>
  join(dirname(from), `${basename(from)}-${branch}`);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for await (const entry of new Bun.Glob('**/*').scan({ cwd: dir, absolute: true })) {
    total += Bun.file(entry).size;
  }
  return total;
}

/** The embedded peer of `createBranch()`: same guarantees, a directory instead of a template. */
export async function branchPglite(
  branch: string,
  options: PgliteBranchOptions,
): Promise<PgliteBranchInfo> {
  // The name is spliced into a filesystem path, so an unvalidated one is traversal rather than a
  // typo — the same reason `createBranch` validates before reaching `CREATE DATABASE`.
  assertBranchName(branch);
  const from = pgliteDataDir(options.from);
  if (from === PGLITE_MEMORY) {
    throw dbNotImplemented(
      'branching an in-memory PGlite',
      'x dev   # a branch copies .x/pgdata, so the database has to be on disk first',
    );
  }
  if (!(await isDirectory(from))) {
    throw dbUnavailable(`there is no PGlite data directory at ${from}, so nothing to branch`);
  }

  const to = options.to ?? pgliteBranchDir(from, branch);
  if (await isDirectory(to)) {
    if (options.force !== true) throw branchExists(branch);
    await rm(to, { recursive: true, force: true });
  }
  await mkdir(dirname(to), { recursive: true });
  // `node:fs` because Bun has no recursive directory copy and PGlite has no TEMPLATE to ask
  // instead. Portable on purpose: the CLI used to shell out to `cp --reflink=auto`, which is a
  // GNU flag that macOS does not have.
  await cp(from, to, { recursive: true });

  return {
    name: branch,
    createdAt: (options.now ?? systemClock.now()).toISOString(),
    dataDir: to,
    sizeBytes: await directorySize(to),
  };
}
