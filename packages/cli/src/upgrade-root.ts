// Where `x upgrade` works: the app, or a repository that holds pins and no `app.config.ts`, which can
// still hop and just cannot be gated. Never a directory above the repository the cwd is in, and never
// a workspace member when a root claims it: the hop moves the whole set or none of it.

// why: a submodule's or worktree's `.git` is a file, and Bun.file cannot tell either kind exists.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join, dirname or relative primitive.
import { dirname, join, relative, resolve } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { appDirsBelow, findAppRoot, requireAppRoot } from './app-root';
import { parseManifest, readManifests, readPins } from './upgrade-pins';
import { workspaceGlobs, workspaceManifestPaths } from './workspace-graph';

export interface UpgradeRoot {
  readonly dir: string;
  /** Whether `dir` holds `app.config.ts`, so `x verify` can answer for it. */
  readonly app: boolean;
}

/** `from`, then each directory above it, stopping at the repository's own root: any `.git`. */
function ancestors(from: string): readonly string[] {
  const dirs: string[] = [];
  let dir = from;
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, '.git'))) return dirs;
    dir = parent;
  }
}

const holdsPins = async (dir: string): Promise<boolean> =>
  (await Bun.file(join(dir, 'package.json')).exists()) &&
  readPins(await readManifests(dir)).length > 0;

const claims = async (root: string, member: string): Promise<boolean> => {
  const path = join(root, 'package.json');
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const globs = workspaceGlobs(parseManifest(path, await file.text()));
  const manifest = `${relative(root, member).replaceAll('\\', '/')}/package.json`;
  return (await workspaceManifestPaths(root, globs)).includes(manifest);
};

/** The app at or above `from`; else the nearest manifest holding pins, or the root claiming it. */
export async function findUpgradeRoot(from: string): Promise<UpgradeRoot> {
  const start = resolve(from);
  const app = findAppRoot(start);
  if (app !== undefined) return { dir: app.dir, app: true };

  const chain = ancestors(start);
  let nearest: number | undefined;
  for (const [index, dir] of chain.entries()) {
    if (await holdsPins(dir)) {
      nearest = index;
      break;
    }
  }
  const held = nearest === undefined ? undefined : chain[nearest];
  if (held === undefined) {
    throw new UltimateError({
      code: 'X_UPGRADE_PIN_UNREADABLE',
      cause: `no package.json at or above ${start} depends on any @ultimat3/* package, so there is nothing to hop from`,
      fix: 'x upgrade --json   # from the directory whose package.json holds the @ultimat3/* dependencies',
    });
  }
  let dir = held;
  for (const above of chain.slice((nearest ?? 0) + 1)) {
    if (await claims(above, dir)) dir = above;
  }
  // An app below is gated from its own directory: a hop from here would claim no gate it could have.
  if (appDirsBelow(dir).length > 0) requireAppRoot('upgrade', dir);
  return { dir, app: false };
}
