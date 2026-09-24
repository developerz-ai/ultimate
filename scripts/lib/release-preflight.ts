// What `scripts/release.ts` refuses before it rewrites a single file: a working tree with changes
// in it, and a version that does not move forward. Plus the one tag command it prints, so every
// tag this repo tells a reader to cut is annotated. Pure — release.ts does the one `git status`.

import type { Finding } from './log';

/** How many dirty paths a refusal names before it summarises the rest. */
export const DIRTY_PATHS_SHOWN = 12;

/**
 * `git status --porcelain` lines to paths. The status is one or two columns then whitespace — the
 * first column is a SPACE for an unstaged edit, so slicing a fixed width is right only while
 * nothing upstream trims the output, and a regex is right either way.
 */
export const dirtyPaths = (porcelain: string): readonly string[] =>
  porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^[ MTADRCU?!]{1,2}\s+/, ''));

/**
 * A release rewrites 47 files and commits them as one. Over a dirty tree that commit carries
 * whatever else was in flight, and the edit it mixes with is the one nobody reviewed as a release.
 * `undefined` is a `git status` that could not run: fail closed, because a tree this could not
 * read is not one it knows to be clean.
 */
export function treeDirtyFindings(
  porcelain: string | undefined,
  rerun: string,
): readonly Finding[] {
  if (porcelain === undefined) {
    return [
      {
        code: 'X_RELEASE_TREE_DIRTY',
        cause:
          '`git status --porcelain` did not run, so whether the working tree is clean is unknown',
        fix: `git status --porcelain && ${rerun}`,
        at: 'scripts/release.ts',
      },
    ];
  }
  const paths = dirtyPaths(porcelain);
  if (paths.length === 0) return [];
  const shown = paths.slice(0, DIRTY_PATHS_SHOWN).join(', ');
  const more = paths.length - DIRTY_PATHS_SHOWN;
  return [
    {
      code: 'X_RELEASE_TREE_DIRTY',
      cause: `the working tree has ${paths.length} uncommitted change(s), which the release commit would carry: ${shown}${more > 0 ? `, and ${more} more` : ''}`,
      fix: `git stash -u && ${rerun}`,
      at: 'scripts/release.ts',
    },
  ];
}

const numbers = (version: string): readonly number[] =>
  (version.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);

/**
 * Semver precedence, near enough for a release: numeric fields, then a prerelease BELOW its own
 * release (`2.0.0-rc.1 < 2.0.0`). `scripts/version-stamps.ts`' `compareVersions` drops the suffix
 * on purpose — its question is whether two versions agree — so it would refuse promoting an rc.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const left = numbers(a);
  const right = numbers(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  const pre = (version: string): string | undefined => {
    const at = version.indexOf('-');
    return at === -1 ? undefined : version.slice(at + 1);
  };
  const [one, other] = [pre(a), pre(b)];
  if (one === other) return 0;
  if (one === undefined) return 1;
  if (other === undefined) return -1;
  return one.localeCompare(other, 'en', { numeric: true });
}

/**
 * The only tag command this repo prints. `--follow-tags` pushes annotated tags only, so a bare
 * `git tag v4.0.0` stayed local and the GitHub Release could not be created against it.
 */
export const annotatedTagCommand = (version: string): string =>
  `git tag -a v${version} -m v${version} && git push origin v${version}`;
