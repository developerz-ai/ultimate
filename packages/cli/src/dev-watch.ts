// Which writes under the app root are a source change, and which are noise. Split out of
// `cmd-dev.ts` because it is a rule with cases rather than four lines of glue, and because the
// answer needs a test of its own: a watcher that reloads on the wrong write is invisible — the
// dev server stays correct and merely does the most expensive thing it can do, repeatedly.
//
// What it was: `filename.includes('.x/') || filename.includes('node_modules')`. Measured against
// ai-maxxing, whose checkout carries `.git/`, `.personal/`, `.claude/worktrees/` (two FULL copies
// of the app) and `coverage/`, every write under any of them ran a whole `appManifest()` plus a
// `buildIslands()` over ten islands. `git status`, an agent's scratch file and a coverage run each
// cost a full rebuild, and each rebuild re-minted every island chunk.
//
// `includes` was also the wrong operator, not just the wrong list: a directory legitimately named
// `my-node_modules-notes/` was excluded from the dev loop for a substring, and `notes/.xyz/` for
// another. The match is on a PATH SEGMENT, so only the directory itself is ever ignored.

/**
 * Directories whose writes are never an app source change.
 *
 * Every entry earns its line and none is a guess:
 * - `.x` — the framework's own state directory: PGlite's data, the dev lock, the static export,
 *   `build-stats.json`. `x build` writes here, which made a build trigger reloads of the process
 *   that was running it.
 * - `node_modules` — an install, not an edit. `x dev` does not reload for a dependency change
 *   because it cannot: the modules are already in this process's cache.
 * - `.git` — the reason this list exists. `git status`, `git fetch` and every commit rewrite index
 *   and ref files continuously, and none of them is a source edit; a checkout of a branch IS one,
 *   but it also writes the source files themselves, which this list does not touch.
 * - `.personal` — an app's uncommitted local state (ai-maxxing's fleet file, its inventory, its
 *   credentials). Written by scripts while the dev server runs.
 * - `.claude` — agent scratch, session logs and worktrees. ai-maxxing keeps two entire copies of
 *   the app under `.claude/worktrees/`, so a second agent's edit rebuilt the first agent's islands.
 * - `dist`, `coverage` — build and test output. Both are written by commands an author runs
 *   BESIDE `x dev`, which is exactly when a spurious rebuild costs the most.
 */
export const IGNORED_DIRECTORIES: readonly string[] = [
  '.x',
  'node_modules',
  '.git',
  '.personal',
  '.claude',
  'dist',
  'coverage',
];

/**
 * A path segment, never a substring. `filename` arrives from `node:fs`'s watcher root-relative and
 * with the platform's separator, so both are normalised before the split — a rule that reads
 * `foo/node_modules/bar` and not `foo\\node_modules\\bar` is a rule that does not exist on Windows.
 */
export function isIgnoredPath(filename: string): boolean {
  const segments = filename.replaceAll('\\', '/').split('/');
  return segments.some((segment) => IGNORED_DIRECTORIES.includes(segment));
}
