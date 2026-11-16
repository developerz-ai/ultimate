// The maintenance lane (SECURITY.md, wiki/Stability.md): a `release/<major>.x` branch ships patches
// of its own major and nothing else. Pure — `scripts/release.ts` reads the branch and asks here
// before a manifest moves; release-tag.yml holds the same rule for a line cut before this file.

import type { Finding } from './log';

const MAINTENANCE_BRANCH = /^release\/([0-9]+)\.x$/;

/** The major a `release/<major>.x` branch maintains; undefined for every other branch name. */
export const maintenanceMajor = (branch: string | undefined): number | undefined => {
  const match = branch === undefined ? null : MAINTENANCE_BRANCH.exec(branch);
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
};

/**
 * The line a bump belongs to: the checked-out branch when it is one, else the branch its upstream
 * tracks (`origin/release/30.x` for a `chore/release-30.9.1` cut from it), else none.
 */
export const laneOf = (
  branch: string | undefined,
  upstream: string | undefined,
): string | undefined => {
  if (maintenanceMajor(branch) !== undefined) return branch;
  const tracked = upstream?.replace(/^[^/]+\//, '');
  return maintenanceMajor(tracked) === undefined ? undefined : tracked;
};

/** The branch a major's maintenance line lives on: one spelling, for the script and the docs. */
export const maintenanceBranch = (major: number): string => `release/${major}.x`;

const lineOf = (version: string): string => version.split('.').slice(0, 2).join('.');

/**
 * On `release/<N>.x`, the version must be a patch of the tree's own `N.Y` line. A minor there is a
 * feature release of an unsupported line, a major there is a second major nobody windowed, and a
 * tree at another major means the branch carries the wrong history: all three refused. `undefined`
 * or any other branch is no lane, so nothing here touches a bump on main.
 */
export function laneFindings(input: {
  readonly branch: string | undefined;
  readonly current: string;
  readonly version: string;
}): readonly Finding[] {
  const major = maintenanceMajor(input.branch);
  if (major === undefined) return [];
  const line = `${major}.`;
  const patch =
    input.current.startsWith(line) &&
    input.version.startsWith(line) &&
    lineOf(input.version) === lineOf(input.current);
  if (patch) return [];
  return [
    {
      code: 'X_RELEASE_LANE_PATCH_ONLY',
      cause: `${input.branch} is the ${major}.x maintenance line, and ${input.current} -> ${input.version} is not a patch of ${major}.x: the line ships security patches of its own major only (SECURITY.md)`,
      fix: `bun run scripts/release.ts --bump patch --dry-run --json   # on ${input.branch} at a ${major}.x tree; a minor or a major is cut on main`,
      at: 'scripts/release.ts',
    },
  ];
}
