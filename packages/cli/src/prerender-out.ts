// The export directory is the build's own, and emptied before every build: `prerenderSite` only
// ever ADDED files, so a route deleted from the app kept shipping its last HTML from `.x/static`.
// Emptied only when it is provably the build's: absent, empty, or marked by an earlier build —
// `--out apps` deleted the app's pages and `--out .x` its embedded dev database.

import { lstat, readdir, rm } from 'node:fs/promises'; // why: Bun has no recursive delete or readdir.
import { isAbsolute, join, relative, resolve, sep } from 'node:path'; // why: Bun ships no path resolve/relative.
import { UltimateError } from '@ultimat3/core';

/** Written into every export directory a build empties: the proof the next build may empty it. */
export const EXPORT_MARKER = '.x-export';

/**
 * The export directory `x build --target static` chooses itself. Exempt from the marker: a build
 * from before the marker existed left it full and unmarked, and the build owns this path by name.
 */
const DEFAULT_EXPORT = join('.x', 'static');

const MARKER_TEXT =
  'Written by x build --target static. This directory is emptied before every static build.\n';

/** True when `dir` is `root` itself or one of its ancestors. */
const containsRoot = (dir: string, root: string): boolean => {
  const up = relative(resolve(dir), resolve(root));
  return up === '' || (up !== '..' && !up.startsWith(`..${sep}`) && !isAbsolute(up));
};

/** Why `out` is not the build's to empty, or `undefined` when it is. */
async function unsafeReason(out: string, root: string): Promise<string | undefined> {
  if (containsRoot(out, root)) return 'is the app root or holds it';
  const stat = await lstat(out).catch(() => undefined);
  if (stat === undefined) return undefined;
  if (!stat.isDirectory()) return 'is not a directory';
  const entries = await readdir(out);
  if (entries.length === 0 || entries.includes(EXPORT_MARKER)) return undefined;
  if (resolve(out) === resolve(root, DEFAULT_EXPORT)) return undefined;
  return `already holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} and no ${EXPORT_MARKER} a previous build wrote`;
}

/** Empties `out` for a fresh export and marks it, or refuses a directory the build did not write. */
export async function clearPrerenderOut(out: string, root: string): Promise<void> {
  const reason = await unsafeReason(out, root);
  if (reason !== undefined) {
    throw new UltimateError({
      code: 'X_BUILD_OUT_UNSAFE',
      cause: `the static export directory ${resolve(out)} ${reason}, and every build empties its export directory first`,
      fix: 'x build --target static --out .x/static --json',
    });
  }
  await rm(out, { recursive: true, force: true });
  await Bun.write(join(out, EXPORT_MARKER), MARKER_TEXT);
}
