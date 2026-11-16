// The maintenance windows SECURITY.md promises: from v30, a major gets security patches for six
// calendar months from the day its successor opened, on `release/<major>.x` under `maint-<major>`.
// Pure and derived from the changelog's dated headings — `release-maint.ts` cuts a lane from it,
// `health-maint.ts` audits one against it, so the date is never kept by hand.

import type { Changelog } from './changelog-sections';
import { maintTag } from './dist-tag';
import { opensMajorLine } from './major-window';
import { maintenanceBranch } from './release-lane';

/** How long a superseded major keeps its lane: SECURITY.md's "6 months". */
export const MAINT_WINDOW_MONTHS = 6;
/** The first major the window was promised to: "The window applies from v30" (SECURITY.md). */
export const MAINT_FROM_MAJOR = 30;

const DATED = /^(\d+)\.\d+\.\d+ - (\d{4}-\d{2}-\d{2})$/;

export interface MaintWindow {
  readonly major: number;
  readonly branch: string;
  readonly distTag: string;
  /** The release that opened the next major line: its date opens this major's window. */
  readonly successor: string;
  readonly opensOn: string;
  /** The last day the window covers, inclusive. */
  readonly closesOn: string;
}

/** `YYYY-MM-DD` plus calendar months in UTC, the day clamped to the target month's last day. */
export function addMonths(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map((part) => Number.parseInt(part, 10));
  const index = year * 12 + (month - 1) + months;
  const lastDay = new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).getUTCDate();
  return new Date(Date.UTC(Math.floor(index / 12), index % 12, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/**
 * One window per superseded major from v30, newest first: the opener of line N+1 (whatever its
 * spelling, `opensMajorLine`'s rule) dates N's window. The current major has no successor, so no
 * window; an undated opener has no date to count from, so none either.
 */
export function maintWindows(changelog: Changelog): readonly MaintWindow[] {
  const windows: MaintWindow[] = [];
  for (const section of changelog) {
    if (!section.released || !opensMajorLine(section.version, changelog)) continue;
    const dated = DATED.exec(section.heading);
    const opened = dated?.[2];
    const major = Number.parseInt(dated?.[1] ?? '', 10) - 1;
    if (opened === undefined || !(major >= MAINT_FROM_MAJOR)) continue;
    windows.push({
      major,
      branch: maintenanceBranch(major),
      distTag: maintTag(major),
      successor: section.version,
      opensOn: opened,
      closesOn: addMonths(opened, MAINT_WINDOW_MONTHS),
    });
  }
  return windows;
}

/** Whether `today` (`YYYY-MM-DD`, UTC) falls inside the window, both ends inclusive. */
export const windowOpen = (window: MaintWindow, today: string): boolean =>
  window.opensOn <= today && today <= window.closesOn;

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Newest stable `major.Y.Z` among `versions`, semver order; undefined when the line has none. */
export function newestOfMajor(versions: Iterable<string>, major: number): string | undefined {
  let best: readonly number[] | undefined;
  let found: string | undefined;
  for (const version of versions) {
    const parts = STABLE.exec(version)?.slice(1).map(Number);
    if (parts === undefined || parts[0] !== major) continue;
    const newer =
      best === undefined ||
      (parts[1] ?? 0) - (best[1] ?? 0) > 0 ||
      ((parts[1] ?? 0) === (best[1] ?? 0) && (parts[2] ?? 0) > (best[2] ?? 0));
    if (newer) [best, found] = [parts, version];
  }
  return found;
}

/**
 * The last `v<major>.Y.Z` tag in `git ls-remote --tags` output, with the COMMIT it names: an
 * annotated tag lists its object first and the commit on its `^{}` line, and a branch must point
 * at the commit.
 */
export function lastTagOfMajor(
  lsRemote: string,
  major: number,
): { readonly tag: string; readonly version: string; readonly sha: string } | undefined {
  const shas = new Map<string, string>();
  for (const line of lsRemote.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    const match = /^refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref ?? '');
    if (sha === undefined || match?.[1] === undefined) continue;
    if (match[2] !== undefined || !shas.has(match[1])) shas.set(match[1], sha);
  }
  const version = newestOfMajor(shas.keys(), major);
  const sha = version === undefined ? undefined : shas.get(version);
  return version === undefined || sha === undefined
    ? undefined
    : { tag: `v${version}`, version, sha };
}

/** Creates the branch on origin through the API: no local checkout of the old tree is needed. */
export const cutBranchCommand = (window: MaintWindow, sha: string): readonly string[] => [
  'gh',
  'api',
  'repos/{owner}/{repo}/git/refs',
  '-f',
  `ref=refs/heads/${window.branch}`,
  '-f',
  `sha=${sha}`,
];

/** Points `maint-<major>` at a version npm already holds: no publish, no new tarball. */
export const distTagCommand = (name: string, version: string, tag: string): readonly string[] => [
  'npm',
  'dist-tag',
  'add',
  `${name}@${version}`,
  tag,
];
