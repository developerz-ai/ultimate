// The export directory is the build's own, and emptied before every build: `prerenderSite` only
// ever ADDED files, so a route deleted from the app kept shipping its last HTML from `.x/static`.
// Refused when `out` is the app root or above it — an `rm -rf` there deletes the app.

import { rm } from 'node:fs/promises'; // why: Bun has no recursive directory delete.
import { isAbsolute, relative, resolve, sep } from 'node:path'; // why: Bun ships no path resolve/relative.
import { UltimateError } from '@ultimat3/core';

/** True when `dir` is `root` itself or one of its ancestors. */
const containsRoot = (dir: string, root: string): boolean => {
  const up = relative(resolve(dir), resolve(root));
  return up === '' || (up !== '..' && !up.startsWith(`..${sep}`) && !isAbsolute(up));
};

/** Empties `out` for a fresh export, or refuses a directory that holds the app. */
export async function clearPrerenderOut(out: string, root: string): Promise<void> {
  if (containsRoot(out, root)) {
    throw new UltimateError({
      code: 'X_CLI_BAD_FLAG',
      cause: `the static export directory ${resolve(out)} is the app root or holds it, and every build empties its export directory first`,
      fix: 'x build --target static --out .x/static --json',
    });
  }
  await rm(out, { recursive: true, force: true });
}
