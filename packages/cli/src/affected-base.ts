// The ref a diff is measured against when `--base` says nothing: the REMOTE-TRACKING default branch
// (`origin/HEAD` → `origin/main`), never local `main` while a remote-tracking ref exists. Local `main` is
// whatever was last pulled, and in a checkout nobody pulls (or a worktree) it lags origin: the diff
// then counts files already merged upstream as this branch's work, and the "affected" set widens.

import type { Runner } from './exec';

/** The branch a change is measured against when no remote-tracking ref names one. */
export const DEFAULT_BASE = 'main';

/** The remote whose default branch is the base. One name: a second guess is a second answer. */
export const DEFAULT_REMOTE = 'origin';

/** What `--help` says the default is, for every command that reads `--base`. */
export const DEFAULT_BASE_HELP = `${DEFAULT_REMOTE}/HEAD's branch (e.g. ${DEFAULT_REMOTE}/${DEFAULT_BASE}), else local ${DEFAULT_BASE} when there is no remote-tracking ref (${DEFAULT_REMOTE}/HEAD or ${DEFAULT_REMOTE}/${DEFAULT_BASE})`;

/**
 * The default base, read from what the checkout already has — never fetched: a command that
 * scopes a test run must not reach the network, and a stale `origin/main` is still nearer the truth
 * than a stale local `main` (`git fetch` moves the first; only a pull moves the second).
 *
 * In order: `origin/HEAD`'s target (a clone sets it), then `origin/main` (a remote added by hand
 * leaves `origin/HEAD` unset), then local `main` — when there is no remote-tracking ref (`origin/HEAD`
 * or `origin/main`): no remote at all, an `origin` never fetched, or one whose branch is not `main`.
 */
export async function defaultBase(runner: Runner, cwd: string): Promise<string> {
  const head = await runner(
    ['git', 'symbolic-ref', '--quiet', '--short', `refs/remotes/${DEFAULT_REMOTE}/HEAD`],
    { cwd },
  );
  const target = head.ok ? head.stdout.trim() : '';
  if (target.length > 0) return target;
  const tracking = `${DEFAULT_REMOTE}/${DEFAULT_BASE}`;
  const main = await runner(
    ['git', 'rev-parse', '--verify', '--quiet', `refs/remotes/${tracking}^{commit}`],
    { cwd },
  );
  return main.ok ? tracking : DEFAULT_BASE;
}

/**
 * The `git fetch` that makes `base` resolvable: a remote-tracking ref is refreshed by fetching its
 * branch, a local one by fetching into it. `origin/main:origin/main` would create a local branch
 * literally named `origin/main`, which is how the old one-size fix line broke on its own default.
 */
export const fetchFixFor = (base: string): string => {
  const prefix = `${DEFAULT_REMOTE}/`;
  return base.startsWith(prefix)
    ? `git fetch --no-tags ${DEFAULT_REMOTE} ${base.slice(prefix.length)}`
    : `git fetch --no-tags ${DEFAULT_REMOTE} ${base}:${base}`;
};
