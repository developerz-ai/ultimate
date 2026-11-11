// The one answer to "what does a raise compare against": `origin/main`'s tip, fetched when the
// checkout lacks it. Shared by `budget-raises` and `pin-raises`, so the two rules cannot disagree
// about the base, and neither can pass on a checkout that has none (a tag checkout in `release.yml`).

import { fetchFromOrigin, type GitRunner } from './git-fetch';
import { run } from './run';

export type { GitRunner };

/** The ref compared against: `origin/main`'s tip, one commit. */
export const BASE_REF = 'origin/main';

const FETCH_MAIN_ARGS = ['--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'];

/**
 * The command that makes `BASE_REF` exist, as a `fix:` line hands it to a person: no `--depth`,
 * so it is safe in a full clone. `baseRef()` itself adds `--depth=1` in a shallow one, as CI does.
 */
export const FETCH_MAIN = ['git', 'fetch', ...FETCH_MAIN_ARGS].join(' ');

const hasBase = async (root: string, runner: GitRunner): Promise<boolean> =>
  (await runner(['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], { cwd: root }))
    .ok;

/** `BASE_REF`, fetched first when this checkout lacks it; `undefined` only when the fetch failed. */
export async function baseRef(root: string, runner: GitRunner = run): Promise<string | undefined> {
  if (await hasBase(root, runner)) return BASE_REF;
  await fetchFromOrigin(root, FETCH_MAIN_ARGS, runner);
  return (await hasBase(root, runner)) ? BASE_REF : undefined;
}

/** A file's text at `base`, or `undefined` when it does not exist there. */
export async function textAt(
  root: string,
  base: string,
  path: string,
  runner: GitRunner = run,
): Promise<string | undefined> {
  const shown = await runner(['git', 'show', `${base}:${path}`], { cwd: root });
  return shown.ok ? shown.output : undefined;
}
