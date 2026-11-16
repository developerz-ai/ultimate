// The maintenance-lane row's read, judge and commands: every window SECURITY.md promises (derived
// from the changelog by `release-maint.ts`) has its `release/<major>.x` branch and `maint-<major>`
// dist-tag while open, and no branch once closed. `scripts/health.ts` wires it; the runners are
// injected so the test reads argv off stubs and nothing touches the network.

import { renderFixShellArg } from '@ultimat3/core';
import type { Changelog } from './changelog-sections';
import { loadChangelog } from './changelog-store';
import type { Finding } from './log';
import { GH_TIMEOUT_MS, gh } from './release-due-gh';
import { type MaintWindow, maintWindows, windowOpen } from './release-maint';
import type { RunResult } from './run';
import { run } from './run';

const BRANCH_ARGS = [
  'api',
  'repos/{owner}/{repo}/git/matching-refs/heads/release/',
  '--jq',
  '.[].ref',
];
const DIST_TAG_ARGS = ['view', '@ultimat3/core', 'dist-tags', '--json'];

// Exported for the test that pins them against the argv the reader spawns: a re-run is the same query.
export const MAINT_BRANCHES_COMMAND = `gh ${BRANCH_ARGS.join(' ')}`;
export const MAINT_DIST_TAGS_COMMAND = `npm ${DIST_TAG_ARGS.join(' ')}`;

type Runner = (args: readonly string[], cwd: string) => Promise<RunResult>;

/** `npm` bounded like `gh`: a read-only lookup with no business holding a checkup. */
const npm: Runner = (args, cwd) => run(['npm', ...args], { cwd, timeoutMs: GH_TIMEOUT_MS });

/** What the row read. `undefined` is a command that answered nothing readable — never "none". */
export interface MaintLaneRead {
  readonly changelog: Changelog;
  readonly branches: readonly string[] | undefined;
  readonly distTags: Readonly<Record<string, string>> | undefined;
}

export interface MaintLaneVerdict {
  readonly row: 'maint-lane';
  readonly verdict: 'healthy' | 'unhealthy';
  readonly reason: string;
  readonly findings: readonly Finding[];
}

/** The one JSON object in npm's output; its warnings share the stream, so slice brace to brace. */
const distTagsOf = (output: string): Readonly<Record<string, string>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(
      output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    return entries.every(([, value]) => typeof value === 'string')
      ? Object.fromEntries(entries as [string, string][])
      : undefined;
  } catch {
    return undefined;
  }
};

export async function maintLaneReader(
  root: string,
  seams: {
    readonly gh?: Runner;
    readonly npm?: Runner;
    readonly load?: (root: string) => Promise<Changelog>;
  } = {},
): Promise<MaintLaneRead> {
  const [refs, tags, changelog] = await Promise.all([
    (seams.gh ?? gh)(BRANCH_ARGS, root),
    (seams.npm ?? npm)(DIST_TAG_ARGS, root),
    (seams.load ?? loadChangelog)(root),
  ]);
  const branches = refs.ok
    ? refs.output
        .split('\n')
        .map((line) => line.trim().replace(/^refs\/heads\//, ''))
        .filter((line) => line.startsWith('release/'))
    : undefined;
  return { changelog, branches, distTags: distTagsOf(tags.output) };
}

const absent = (window: MaintWindow, cause: string): Finding => ({
  code: 'X_MAINT_LANE_ABSENT',
  cause: `${cause}, and SECURITY.md promises ${window.major}.x security patches from ${window.branch} under ${window.distTag} until ${window.closesOn}`,
  fix: `bun run scripts/release-maint.ts --major ${renderFixShellArg(String(window.major), '<major>')} --dry-run --json`,
  at: 'SECURITY.md',
});

/** Pure: the lane against every promised window, on `today` (`YYYY-MM-DD`, UTC). */
export function maintLaneFindings(input: {
  readonly windows: readonly MaintWindow[];
  readonly today: string;
  readonly branches: readonly string[];
  readonly distTags: Readonly<Record<string, string>>;
}): readonly Finding[] {
  return input.windows.flatMap((window): Finding[] => {
    const branchUp = input.branches.includes(window.branch);
    if (!windowOpen(window, input.today)) {
      return input.today > window.closesOn && branchUp
        ? [
            {
              code: 'X_MAINT_LANE_EXPIRED',
              cause: `${window.branch} is still on origin, but ${window.major}.x's maintenance window closed on ${window.closesOn} (six months after ${window.successor})`,
              fix: `git push origin --delete ${renderFixShellArg(window.branch, 'release/<major>.x')}   # then drop the ${window.major}.x row from SECURITY.md's supported versions`,
              at: 'SECURITY.md',
            },
          ]
        : [];
    }
    const tagged = input.distTags[window.distTag];
    return [
      ...(branchUp ? [] : [absent(window, `origin has no ${window.branch} branch`)]),
      ...(tagged === undefined
        ? [absent(window, `npm names no ${window.distTag} dist-tag for @ultimat3/core`)]
        : tagged.startsWith(`${window.major}.`)
          ? []
          : [
              absent(
                window,
                `npm's ${window.distTag} names ${tagged}, which is not a ${window.major}.x version`,
              ),
            ]),
    ];
  });
}

/** The row's verdict, or the checkup's refusal when either command answered nothing readable. */
export function judgeMaintLane(read: MaintLaneRead, today: string): MaintLaneVerdict | Finding {
  if (read.branches === undefined || read.distTags === undefined) {
    const command = read.branches === undefined ? MAINT_BRANCHES_COMMAND : MAINT_DIST_TAGS_COMMAND;
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the maint-lane row could not be read: ${command} answered nothing readable`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  const windows = maintWindows(read.changelog);
  const findings = maintLaneFindings({
    windows,
    today,
    branches: read.branches,
    distTags: read.distTags,
  });
  return findings.length === 0
    ? {
        row: 'maint-lane',
        verdict: 'healthy',
        reason:
          windows.length === 0
            ? 'no superseded major from v30 is owed a maintenance lane'
            : `every maintenance window matches its lane: ${windows.map((window) => `${window.major}.x until ${window.closesOn}`).join(', ')}`,
        findings,
      }
    : {
        row: 'maint-lane',
        verdict: 'unhealthy',
        reason: findings.map((finding) => finding.cause).join('; '),
        findings,
      };
}
