// Which paths under the app root `x dev` must not watch, and the rule is REGISTRATION rather than
// filtering: `watch(root, { recursive: true })` takes one inotify descriptor per directory before
// any filter runs, so an answer given after the event has already cost the kernel queue, a JS
// callback and a slot out of `max_user_watches`. Measured on a monorepo root: 1901 descriptors,
// 1490 of them under `.git/` and `node_modules/`, and one `git status` delivering 5 events.
//
// The ignore set is the app's own `.gitignore`, read with git's own anchoring (`gitignore.ts`),
// plus a floor of directory names an ignore file need not name. It was seven hand-listed names,
// and both halves of that were wrong: nothing read `.gitignore`, so `tsconfig.tsbuildinfo` —
// rewritten by every `bun run typecheck` — ran a full `appManifest()` plus `buildIslands()`; and
// `dist` and `coverage` were matched at ANY depth, so an app's own `/dist` or `/coverage` route
// never reloaded at all, silently.

// why: Bun exposes no path-join primitive. The same necessity `fix-path.ts` already records.
import { join } from 'node:path';
import type { IgnoreScope } from './gitignore';
import { ignoreScopes, isGitIgnored } from './gitignore';
import { pathSegments } from './path-segments';

/**
 * Directory names no `.gitignore` can be relied on to carry, matched as a path SEGMENT at any
 * depth. Every entry earns its line, and every one is either dotted or `node_modules` — which is
 * what makes the any-depth match safe: a `site/` subtree is a URL tree, and neither a dot-directory
 * nor an install is ever a route.
 *
 * - `.git` — git never names its own directory in an ignore file, and `git status`, `git fetch` and
 *   every commit rewrite index and ref files continuously. The reason this list exists.
 * - `.x` — the framework's own state: PGlite's data directory (which THIS process writes
 *   continuously), the dev lock, the static export, `build-stats.json`.
 * - `node_modules` — an install, not an edit. `x dev` cannot reload for a dependency change: the
 *   modules are already in this process's cache.
 * - `.personal` — an app's uncommitted local state, written by scripts while the dev server runs.
 * - `.claude` — agent scratch, session logs and worktrees. ai-maxxing keeps two entire copies of
 *   the app under `.claude/worktrees/`, so a second agent's edit rebuilt the first agent's islands.
 *
 * `dist` and `coverage` were here and are deliberately not: both are ordinary build output that
 * every ignore file already names, and hand-listing them cost an app its own routes.
 */
export const ALWAYS_IGNORED_DIRECTORIES: readonly string[] = [
  '.git',
  '.x',
  'node_modules',
  '.personal',
  '.claude',
];

/** The ignore set as one question, so the walk and the event filter cannot disagree. */
export interface DevIgnore {
  /** `path` is app-root-relative; `isDirectory` decides every trailing-slash rule git holds. */
  ignores(path: string, isDirectory: boolean): boolean;
  /** The `.gitignore` files this set was built from, outermost first — what `--json` can report. */
  readonly scopes: readonly IgnoreScope[];
}

/**
 * Read once, at boot and again on every write that names `.gitignore`. A snapshot rather than a
 * live reader: the watcher rebuilds the whole set and re-walks, so a directory the author just
 * ignored drops its descriptor instead of keeping one nothing will ever read an event from.
 *
 * Two limits, both deliberate. An ANCESTOR ignore file is read at boot and is not watched — it sits
 * outside the app root, so `x dev` has no descriptor there and a restart is the way to pick up an
 * edit to it. A NESTED one (`apps/web/.gitignore`) is not read at all: `ignoreScopes` walks upward
 * only, and watching for one would mean a scope per directory in the tree.
 */
export function devIgnore(root: string): DevIgnore {
  const scopes = ignoreScopes(root);
  return {
    scopes,
    ignores(path: string, isDirectory: boolean): boolean {
      const segments = pathSegments(path);
      if (segments.some((segment) => ALWAYS_IGNORED_DIRECTORIES.includes(segment))) return true;
      return isGitIgnored(scopes, join(root, ...segments), isDirectory);
    },
  };
}
