// The one answer to "what does a raise compare against": `origin/main`'s tip, fetched when the
// checkout lacks it. Shared by `budget-raises` and `pin-raises`, so the two rules cannot disagree
// about the base, and neither can pass on a checkout that has none (a tag checkout in `release.yml`).

import { run } from './run';

/** The ref compared against: `origin/main`'s tip, one commit. */
export const BASE_REF = 'origin/main';

/** The one command that makes `BASE_REF` exist in a shallow checkout — what CI runs. */
export const FETCH_MAIN =
  'git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main';

export type GitRunner = (
  command: readonly string[],
  options: { readonly cwd: string },
) => ReturnType<typeof run>;

const hasBase = async (root: string, runner: GitRunner): Promise<boolean> =>
  (await runner(['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], { cwd: root }))
    .ok;

/** `BASE_REF`, fetched first when this checkout lacks it; `undefined` only when the fetch failed. */
export async function baseRef(root: string, runner: GitRunner = run): Promise<string | undefined> {
  if (await hasBase(root, runner)) return BASE_REF;
  await runner(FETCH_MAIN.split(' '), { cwd: root });
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
