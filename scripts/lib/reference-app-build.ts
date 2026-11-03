// The build that precedes each tracked app's gate: `x build --target static`, then `x verify`.
// `budgets` would build on its own when the stats are stale (plan 101, 21); building first keeps a
// failed build this script's finding, and leaves `budgets` fresh stats so it never builds twice.

// why: `rm -r` on a directory — Bun.file().delete() removes one file and never a tree.
import { rm } from 'node:fs/promises';
// why: host-separator paths to the app root; Bun ships no path API.
import { join } from 'node:path';
import type { Runner } from '@ultimat3/cli';
import { execOutput } from '@ultimat3/cli';
import type { GatedApp } from './gated-apps';
import type { Finding } from './log';

/**
 * Everything a previous build left under `.x/` that this gate reads back. Cleared first, because a
 * checkout keeps them (`.x/` is gitignored, never cleaned) and CI never has them: a local run read
 * an old `static-report.json` and answered differently from the same commit in CI. `pgdata/` and
 * `storage/` are the app's state, not build output, and stay.
 */
export const STALE_BUILD_OUTPUTS = [
  '.x/static',
  '.x/static-report.json',
  '.x/build-stats.json',
] as const;

/** Runnable from the repo root, like the gate's own `reproduce` line. */
const reproduceBuild = (app: GatedApp): string => {
  const up = '../'.repeat(app.dir.split('/').length);
  return `cd ${app.dir} && bun run ${up}packages/cli/src/bin.ts build --target static`;
};

/**
 * Clear the stale outputs and build the app. `undefined` when the build succeeded; a failed build
 * is the app regressing — the gate's own build would stop there too — never a
 * red `budgets` step for the reader to trace back to it.
 */
export const buildApp = async (
  root: string,
  runner: Runner,
  app: GatedApp,
): Promise<Finding | undefined> => {
  const cwd = join(root, app.dir);
  for (const path of STALE_BUILD_OUTPUTS) {
    await rm(join(cwd, path), { recursive: true, force: true });
  }
  const result = await runner(
    ['bun', 'run', join(root, 'packages/cli/src/bin.ts'), 'build', '--target', 'static'],
    { cwd },
  );
  if (result.ok) return undefined;
  return {
    code: 'X_REFERENCE_APP_REGRESSED',
    cause: `x build --target static failed for ${app.dir}, before its gate could run: ${execOutput(result)}`,
    fix: reproduceBuild(app),
    at: app.dir,
  };
};
