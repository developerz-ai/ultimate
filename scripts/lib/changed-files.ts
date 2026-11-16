// What this checkout changed since it left `origin/main`: the merge base when the history reaches
// one, the fetched tip when it does not (CI's depth-1 checkout of a PR's merge commit, where the tip
// IS the first parent), and the working tree — so a worker's uncommitted edit counts. Never fetches:
// parallel tests that each fetched raced on `.git/shallow.lock` (`base-ref.ts`).

import { BASE_REF, type GitRunner } from './base-ref';
import { run } from './run';

export interface ChangedFiles {
  /** The commit compared against, or `undefined` when this checkout has no `origin/main`. */
  readonly base: string | undefined;
  /** How `base` was found: the merge base, the tip itself, or not at all. */
  readonly via: 'merge-base' | 'tip' | 'none';
  /** Every path that differs from `base`, tracked or untracked, repo-relative and `/`-spelt. */
  readonly changed: readonly string[];
  /** The subset of `changed` that `base` does not have at all. */
  readonly added: readonly string[];
}

const lines = (output: string): string[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** The commit to diff against: the merge base with `origin/main`, else its tip, else none. */
export async function baseCommit(
  root: string,
  runner: GitRunner = run,
): Promise<{ readonly base: string | undefined; readonly via: ChangedFiles['via'] }> {
  const tip = await runner(['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], {
    cwd: root,
  });
  if (!tip.ok) return { base: undefined, via: 'none' };
  const merge = await runner(['git', 'merge-base', 'HEAD', BASE_REF], { cwd: root });
  const sha = merge.ok ? merge.output.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha)
    ? { base: sha, via: 'merge-base' }
    : { base: BASE_REF, via: 'tip' };
}

/** The paths this checkout changed since `origin/main`, working tree and untracked files included. */
export async function changedSinceBase(
  root: string,
  runner: GitRunner = run,
): Promise<ChangedFiles> {
  const { base, via } = await baseCommit(root, runner);
  if (base === undefined) return { base, via, changed: [], added: [] };
  const diff = (filter: readonly string[]) =>
    runner(['git', 'diff', '--name-only', '--no-renames', ...filter, base, '--'], { cwd: root });
  const [all, created, untracked] = await Promise.all([
    diff([]),
    diff(['--diff-filter=A']),
    runner(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: root }),
  ]);
  const fresh = untracked.ok ? lines(untracked.output) : [];
  const changed = [...new Set([...(all.ok ? lines(all.output) : []), ...fresh])].sort();
  const added = [...new Set([...(created.ok ? lines(created.output) : []), ...fresh])].sort();
  return { base, via, changed, added };
}
