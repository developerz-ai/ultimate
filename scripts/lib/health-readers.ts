// The health checkup's default readers: what each row reads, and the one query row 4 asks `gh` for.
// The runner is a parameter, so a test drives a real reader and reads the argv it asked for: no
// subprocess, no second copy. Rows 9 onward read in their own health-<row>.ts; this table composes
// them, so the checkup stays one reader map.

import type { BenchRead } from './health-bench';
import { benchReader } from './health-bench';
import type { BotIssuesRead } from './health-bot-issues';
import { botIssuesReader } from './health-bot-issues';
import type { BranchesRead } from './health-branches';
import { branchesReader } from './health-branches';
import type { CompatRead } from './health-compat';
import { compatReader } from './health-compat';
import type { DocsOriginRead } from './health-docs-origin';
import { docsOriginReader } from './health-docs-origin';
import type { FlakeHuntRead } from './health-flake-hunt';
import { flakeHuntReader } from './health-flake-hunt';
import type { MaintLaneRead } from './health-maint';
import { maintLaneReader } from './health-maint';
import type { ReleaseExistsRead } from './health-release';
import { releaseExistsReader } from './health-release';
import type { SecretRead } from './health-secret';
import { secretReader } from './health-secret';
import type { TrustRead } from './health-trust';
import { trustReader } from './health-trust';
import type { TutorialsRunRead } from './health-tutorials';
import { tutorialsRunReader } from './health-tutorials';
import { gh } from './release-due-gh';
import { git } from './release-due-git';
import type { RunResult } from './run';
import { run } from './run';

/**
 * The `gh run list --json` fields row 4 asks for: the release-tag workflow's five newest runs
 * with the fields a filing needs — the run's status and conclusion, its id, its title, the commit
 * it ran at, its URL and when it was created. The same set and order as the release-due
 * `awaiting_tag` watch command, so one query answers both rows.
 */
export const TAG_RUN_FIELDS = 'status,conclusion,databaseId,displayTitle,headSha,url,createdAt';

// Exported for the test that pins the query: the reader's argv, field list and all.
export const TAG_RUN_ARGS = [
  'run',
  'list',
  '--workflow',
  'release-tag.yml',
  '--limit',
  '5',
  '--json',
  TAG_RUN_FIELDS,
] as const;

// Exported for the test that pins the prefix: without `bun` first, run() spawns a binary named
// `run`, which no normal Bun installation has, and the row refuses everywhere.
export const CI_ARGS = [
  'bun',
  'run',
  'x',
  '--',
  'ci',
  '--workflow',
  'ci.yml',
  '--event',
  'push',
  '--branch',
  'main',
  '--json',
] as const;

/** Row 7's page size: a page this full is truncated, and the brief files nothing off it. */
export const DEPENDABOT_LIMIT = 5;

const GIT_BROKEN = { ok: false as const, output: '' };

/** The origin/main tip, or undefined when git could not say — a read that failed is unreadable. */
const headShaOf = async (root: string): Promise<string | undefined> =>
  git(['rev-parse', 'origin/main'], root).then(
    (answer) => (answer.ok ? answer.output.trim() : undefined),
    () => undefined,
  );

/**
 * The `--json` document in a child's output: the whole output, else the last line that parses to an
 * object. `run()` joins the child's stderr into its output, and gh writes progress there — a
 * parse over the join would refuse answers that are present. Exit codes are never read: `x ci` and
 * both child scripts print their document whatever they decided.
 */
export function jsonDocument(output: string): unknown {
  try {
    return JSON.parse(output.trim()) as unknown;
  } catch {
    // Not one document over the whole output: the document may be one line among stderr noise.
  }
  const lines = output.split('\n');
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = (lines[at] ?? '').trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // Not this line either.
    }
  }
  return undefined;
}

/** What each row's reader answers: the child documents as parsed `unknown`, git as a plain string. */
export interface MainGreenRead {
  readonly ci: unknown;
  readonly expectedSha: string | undefined;
}
export interface LastTagRead {
  readonly tagCommit: string | undefined;
  readonly runs: unknown;
}
export interface StampedTaggedRead {
  readonly releaseDue: unknown;
}
export interface TagRunsRead {
  readonly runs: unknown;
}
export interface NpmTreeRead {
  readonly audit: unknown;
}
export interface AlarmsRead {
  readonly issues: unknown;
}
export interface DependabotRead {
  readonly prs: unknown;
}
export interface DemoShippedRead {
  readonly runs: unknown;
}

export interface HealthReaders {
  readonly 'main-green': () => Promise<MainGreenRead>;
  readonly 'last-tag-published': () => Promise<LastTagRead>;
  readonly 'stamped-version-tagged': () => Promise<StampedTaggedRead>;
  readonly 'tag-runs-ended-well': () => Promise<TagRunsRead>;
  readonly 'npm-serves-tree': () => Promise<NpmTreeRead>;
  readonly 'automation-alarms': () => Promise<AlarmsRead>;
  readonly 'dependabot-not-stuck': () => Promise<DependabotRead>;
  readonly 'demo-shipped': () => Promise<DemoShippedRead>;
  readonly 'release-exists': () => Promise<ReleaseExistsRead>;
  readonly 'tutorials-run': () => Promise<TutorialsRunRead>;
  readonly 'flake-hunt': () => Promise<FlakeHuntRead>;
  readonly bench: () => Promise<BenchRead>;
  readonly compat: () => Promise<CompatRead>;
  readonly 'maint-lane': () => Promise<MaintLaneRead>;
  readonly 'registry-trust': () => Promise<TrustRead>;
  readonly 'private-names-secret': () => Promise<SecretRead>;
  readonly 'docs-site-origin': () => Promise<DocsOriginRead>;
  readonly 'stale-bot-issues': () => Promise<BotIssuesRead>;
  readonly 'stale-branches': () => Promise<BranchesRead>;
}

/** Replaces any single reader, so a test names a world without one subprocess. */
export type HealthOverrides = {
  readonly [Key in keyof HealthReaders]?: HealthReaders[Key];
};

/**
 * The `gh` runner the readers spawn: the real one by default, a stub in a test. The seam is the
 * ARGV, so a test reads what the row asked for — never a copy of the query written down beside it.
 */
export type GhRunner = (args: readonly string[], cwd: string) => Promise<RunResult>;

export const defaultReaders = (root: string, ghRunner: GhRunner = gh): HealthReaders => ({
  'main-green': async () => ({
    ci: jsonDocument((await run([...CI_ARGS], { cwd: root })).output),
    expectedSha: await headShaOf(root),
  }),
  'last-tag-published': async () => {
    const described = await git(
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'origin/main'],
      root,
    ).catch(() => GIT_BROKEN);
    const tag = described.ok ? described.output.trim() : '';
    // The tag's PEELED COMMIT — `<tag>^{commit}` — is what names the commit an annotated tag marks;
    // `gh run list` exposes no ref, so this is the only field a run's headSha can be judged
    // against.
    const tagCommit =
      tag === ''
        ? undefined
        : await git(['rev-parse', `${tag}^{commit}`], root).then(
            (answer) => (answer.ok ? answer.output.trim() : undefined),
            () => undefined,
          );
    const runs = await ghRunner(
      [
        'run',
        'list',
        '--workflow',
        'release.yml',
        '--limit',
        '1',
        '--json',
        'conclusion,headBranch,event,headSha,url',
      ],
      root,
    );
    return { tagCommit, runs: jsonDocument(runs.output) };
  },
  'stamped-version-tagged': async () => ({
    releaseDue: jsonDocument(
      (await run(['bun', 'run', 'scripts/release-due.ts', '--json'], { cwd: root })).output,
    ),
  }),
  'tag-runs-ended-well': async () => ({
    runs: jsonDocument((await ghRunner([...TAG_RUN_ARGS], root)).output),
  }),
  'npm-serves-tree': async () => ({
    audit: jsonDocument(
      (await run(['bun', 'run', 'scripts/registry-audit.ts', '--json'], { cwd: root })).output,
    ),
  }),
  'automation-alarms': async () => ({
    issues: jsonDocument(
      (
        await ghRunner(
          [
            'issue',
            'list',
            '--state',
            'open',
            '--label',
            'registry-drift',
            '--json',
            'number,title,state,createdAt,updatedAt,url',
          ],
          root,
        )
      ).output,
    ),
  }),
  'dependabot-not-stuck': async () => ({
    prs: jsonDocument(
      (
        await ghRunner(
          [
            'pr',
            'list',
            '--app',
            'dependabot',
            '--limit',
            String(DEPENDABOT_LIMIT),
            '--state',
            'open',
            '--json',
            'number,createdAt,updatedAt,statusCheckRollup',
          ],
          root,
        )
      ).output,
    ),
  }),
  'demo-shipped': async () => ({
    runs: jsonDocument(
      (
        await ghRunner(
          [
            'run',
            'list',
            '--workflow',
            'deploy-social-demo.yml',
            '--limit',
            '1',
            '--json',
            'databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt',
          ],
          root,
        )
      ).output,
    ),
  }),
  'release-exists': () => releaseExistsReader(root, ghRunner),
  'tutorials-run': () => tutorialsRunReader(root, ghRunner),
  'flake-hunt': () => flakeHuntReader(root, ghRunner),
  bench: () => benchReader(root, ghRunner),
  compat: () => compatReader(root, ghRunner),
  'maint-lane': () => maintLaneReader(root, { gh: ghRunner }),
  'registry-trust': () => trustReader(root),
  'private-names-secret': () => secretReader(root, ghRunner),
  'docs-site-origin': () => docsOriginReader(root, ghRunner),
  'stale-bot-issues': () => botIssuesReader(root, ghRunner),
  'stale-branches': () => branchesReader(root, ghRunner),
});
