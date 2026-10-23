#!/usr/bin/env bun
// Answer whether the project is healthy: eight rows, one verdict each, read from git, `gh` and the
// repo's own scripts, and refuse with `cannot tell` and no data when any row's command cannot be
// read — a checkup that answers over a row it never read is the silent green it exists to refuse.
//
//   bun run scripts/health.ts [--json]

import { renderThrowable } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import {
  narrowAudit,
  narrowChildDoc,
  narrowCiDoc,
  narrowIssues,
  narrowPrs,
  narrowReleaseDue,
  narrowRuns,
} from './lib/health-narrow';
import type { RowId, RowVerdict, Verdict } from './lib/health-rule';
import {
  alarmsVerdict,
  demoShippedVerdict,
  dependabotVerdict,
  lastTagVerdict,
  mainGreenVerdict,
  npmTreeVerdict,
  ROW_IDS,
  stampedTaggedVerdict,
  tagRunsVerdict,
} from './lib/health-rule';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { gh } from './lib/release-due-gh';
import { git } from './lib/release-due-git';
import { repoRoot, run } from './lib/run';

const SCRIPT = 'health';

/** The one new code: a row's command answered nothing readable, so the whole checkup cannot answer. */
const unreadable = (row: string, command: string, detail: string): Finding => ({
  code: 'X_HEALTH_ROW_UNREADABLE',
  cause: `the ${row} row could not be read: ${command} — ${detail}`,
  fix: 'bun run scripts/health.ts --json',
  at: 'scripts/health.ts',
});

const ROW_COMMANDS: Readonly<Record<RowId, string>> = {
  'main-green':
    'bun run x -- ci --workflow ci.yml --event push --branch main --json; git rev-parse origin/main',
  'last-tag-published':
    "git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main; git rev-parse <tag>^{commit}; gh run list --workflow release.yml --limit 1",
  'stamped-version-tagged': 'bun run scripts/release-due.ts --json',
  'tag-runs-ended-well': 'gh run list --workflow release-tag.yml --limit 5',
  'npm-serves-tree': 'bun run scripts/registry-audit.ts --json',
  'automation-alarms': 'gh issue list --state open --label registry-drift',
  'dependabot-not-stuck': 'gh pr list --app dependabot',
  'demo-shipped': 'gh run list --workflow deploy-social-demo.yml --limit 1',
};

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

const GIT_BROKEN = { ok: false as const, output: '' };

/** The origin/main tip, or undefined when git could not say — a read that failed is unreadable. */
const headShaOf = async (root: string): Promise<string | undefined> =>
  git(['rev-parse', 'origin/main'], root).then(
    (answer) => (answer.ok ? answer.output.trim() : undefined),
    () => undefined,
  );

/**
 * The `--json` document in a child's output: the whole output, else the last line that parses to an
 * object. `run()` joins the child's stderr into its output, and gh writes progress there — a parse
 * over the join would refuse answers that are present. Exit codes are never read: `x ci` and both
 * child scripts print their document whatever they decided.
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
}

/** Replaces any single reader, so a test names a world without one subprocess. */
export type HealthOverrides = {
  readonly [Key in keyof HealthReaders]?: HealthReaders[Key];
};

const defaultReaders = (root: string): HealthReaders => ({
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
    // `gh run list` exposes no ref, so this is the only field a run's headSha can be judged against.
    const tagCommit =
      tag === ''
        ? undefined
        : await git(['rev-parse', `${tag}^{commit}`], root).then(
            (answer) => (answer.ok ? answer.output.trim() : undefined),
            () => undefined,
          );
    const runs = await gh(
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
    runs: jsonDocument(
      (
        await gh(
          [
            'run',
            'list',
            '--workflow',
            'release-tag.yml',
            '--limit',
            '5',
            '--json',
            'status,conclusion',
          ],
          root,
        )
      ).output,
    ),
  }),
  'npm-serves-tree': async () => ({
    audit: jsonDocument(
      (await run(['bun', 'run', 'scripts/registry-audit.ts', '--json'], { cwd: root })).output,
    ),
  }),
  'automation-alarms': async () => ({
    issues: jsonDocument(
      (
        await gh(
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
        await gh(
          [
            'pr',
            'list',
            '--app',
            'dependabot',
            '--json',
            'number,createdAt,updatedAt,url,state,autoMergeRequest,statusCheckRollup',
          ],
          root,
        )
      ).output,
    ),
  }),
  'demo-shipped': async () => ({
    runs: jsonDocument(
      (
        await gh(
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
});

type Judgement = RowVerdict | Finding | readonly Finding[];

/**
 * Splits a judge's answer into its refusal findings and its one verdict. The built-in
 * `Array.isArray` guard cannot do it: a `readonly` array is kept in BOTH of its branches, so the
 * verdict branch would still carry `readonly Finding[]`.
 */
const isFindings = (answer: Judgement): answer is readonly Finding[] => Array.isArray(answer);

const judgeMainGreen = (read: MainGreenRead): Judgement => {
  const ci = narrowCiDoc(read.ci);
  if (ci === undefined || read.expectedSha === undefined) {
    return unreadable(
      'main-green',
      ROW_COMMANDS['main-green'],
      'the x ci document or the origin/main sha did not answer',
    );
  }
  if (!ci.ok && !ci.runNotFound && ci.runs.length === 0) {
    return unreadable(
      'main-green',
      ROW_COMMANDS['main-green'],
      'the command refused without naming a missing run',
    );
  }
  return mainGreenVerdict({ ci, expectedSha: read.expectedSha });
};

const judgeLastTag = (read: LastTagRead): Judgement => {
  if (read.runs === undefined || read.tagCommit === undefined) {
    return unreadable(
      'last-tag-published',
      ROW_COMMANDS['last-tag-published'],
      'git could not name the last v* tag on origin/main, or gh printed no JSON document',
    );
  }
  return lastTagVerdict({ tagCommit: read.tagCommit, run: narrowRuns(read.runs)[0] });
};

const judgeStampedTagged = (read: StampedTaggedRead): Judgement => {
  const doc = narrowChildDoc(read.releaseDue);
  if (doc === undefined) {
    return unreadable(
      'stamped-version-tagged',
      ROW_COMMANDS['stamped-version-tagged'],
      'release-due printed no JSON document',
    );
  }
  // The child's own refusal IS the answer: its findings pass through verbatim, never re-wrapped.
  if (!doc.ok) {
    return doc.findings.length > 0
      ? doc.findings
      : unreadable(
          'stamped-version-tagged',
          ROW_COMMANDS['stamped-version-tagged'],
          'release-due refused without a readable findings block',
        );
  }
  const data = narrowReleaseDue(doc.data);
  if (data === undefined) {
    return unreadable(
      'stamped-version-tagged',
      ROW_COMMANDS['stamped-version-tagged'],
      'release-due answered with no readable data',
    );
  }
  return stampedTaggedVerdict(data);
};

const judgeTagRuns = (read: TagRunsRead): Judgement => {
  // A document that is not a run list, or whose entries name no readable run, is junk — never an
  // empty list: `healthy` is this row's answer to an empty list, so answering it over a document
  // that said nothing readable is the silent green this file refuses on.
  if (!Array.isArray(read.runs)) {
    return unreadable(
      'tag-runs-ended-well',
      ROW_COMMANDS['tag-runs-ended-well'],
      'gh printed no JSON document, or one that is not a run list',
    );
  }
  const runs = narrowRuns(read.runs);
  if (runs.length < read.runs.length) {
    return unreadable(
      'tag-runs-ended-well',
      ROW_COMMANDS['tag-runs-ended-well'],
      'the run list held an entry with no readable conclusion',
    );
  }
  return tagRunsVerdict({ runs });
};

const judgeNpmTree = (read: NpmTreeRead): Judgement => {
  const audit = narrowAudit(read.audit);
  if (audit === undefined) {
    return unreadable(
      'npm-serves-tree',
      ROW_COMMANDS['npm-serves-tree'],
      'registry-audit printed no JSON document',
    );
  }
  return npmTreeVerdict({ audit });
};

const judgeAlarms = (read: AlarmsRead, nowMs: number): Judgement => {
  if (read.issues === undefined) {
    return unreadable(
      'automation-alarms',
      ROW_COMMANDS['automation-alarms'],
      'gh printed no JSON document',
    );
  }
  return alarmsVerdict({ issues: narrowIssues(read.issues), nowMs });
};

const judgeDependabot = (read: DependabotRead, nowMs: number): Judgement => {
  if (read.prs === undefined) {
    return unreadable(
      'dependabot-not-stuck',
      ROW_COMMANDS['dependabot-not-stuck'],
      'gh printed no JSON document',
    );
  }
  return dependabotVerdict({ prs: narrowPrs(read.prs), nowMs });
};

const judgeDemoShipped = (read: DemoShippedRead, mainGreen: Verdict): Judgement => {
  if (read.runs === undefined) {
    return unreadable('demo-shipped', ROW_COMMANDS['demo-shipped'], 'gh printed no JSON document');
  }
  return demoShippedVerdict({ run: narrowRuns(read.runs)[0] }, mainGreen);
};

/**
 * The whole checkup at `root`: every row read in the brief's order, one subprocess at a time, each
 * judge over what its reader answered. A throw — `Bun.spawn` throws on a missing binary — or an
 * unreadable answer refuses the whole result with findings and no `data`; otherwise every verdict
 * rides in `data.rows`, and `data.healthy` is true only when all eight read `healthy`.
 */
export const healthAt = async (
  root: string,
  overrides: HealthOverrides = {},
): Promise<ScriptResult> => {
  const readers: HealthReaders = { ...defaultReaders(root), ...overrides };
  const nowMs = Date.now();
  const judged = new Map<RowId, RowVerdict>();
  const refusals: Finding[] = [];

  const judge = async <T>(
    row: RowId,
    read: () => Promise<T>,
    toVerdict: (read: T) => Judgement,
  ): Promise<void> => {
    try {
      const answer = toVerdict(await read());
      if (isFindings(answer)) refusals.push(...answer);
      else if ('row' in answer) judged.set(row, answer);
      else refusals.push(answer);
    } catch (cause) {
      refusals.push(unreadable(row, ROW_COMMANDS[row], renderThrowable(cause)));
    }
  };

  const green = (): Verdict => judged.get('main-green')?.verdict ?? 'unverdicted';
  await judge('main-green', readers['main-green'], judgeMainGreen);
  await judge('last-tag-published', readers['last-tag-published'], judgeLastTag);
  await judge('stamped-version-tagged', readers['stamped-version-tagged'], judgeStampedTagged);
  await judge('tag-runs-ended-well', readers['tag-runs-ended-well'], judgeTagRuns);
  await judge('npm-serves-tree', readers['npm-serves-tree'], judgeNpmTree);
  await judge('automation-alarms', readers['automation-alarms'], (read) =>
    judgeAlarms(read, nowMs),
  );
  await judge('dependabot-not-stuck', readers['dependabot-not-stuck'], (read) =>
    judgeDependabot(read, nowMs),
  );
  await judge('demo-shipped', readers['demo-shipped'], (read) => judgeDemoShipped(read, green()));

  if (refusals.length > 0) {
    return { ok: false, script: SCRIPT, summary: 'cannot tell', findings: refusals };
  }
  const rows = ROW_IDS.map((row) => judged.get(row)).filter((row) => row !== undefined);
  const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
  return {
    ok: true,
    script: SCRIPT,
    summary: `${count('healthy')} healthy, ${count('unhealthy')} unhealthy, ${count('unverdicted')} unverdicted of ${ROW_IDS.length} rows`,
    lines: rows.map((row) => `  ${row.row.padEnd(22)} ${row.verdict.padEnd(11)} ${row.reason}`),
    data: { healthy: rows.every((row) => row.verdict === 'healthy'), rows },
  };
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(await healthAt(repoRoot()), args.json);
}
