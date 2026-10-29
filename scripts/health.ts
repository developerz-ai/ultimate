#!/usr/bin/env bun
// Answer whether the project is healthy: nine rows, one verdict each, read from git, `gh` and the
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
  type RunRow,
} from './lib/health-narrow';
import type {
  AlarmsRead,
  DemoShippedRead,
  DependabotRead,
  HealthOverrides,
  HealthReaders,
  LastTagRead,
  MainGreenRead,
  NpmTreeRead,
  StampedTaggedRead,
  TagRunsRead,
} from './lib/health-readers';
import { defaultReaders, TAG_RUN_FIELDS } from './lib/health-readers';
import { judgeReleaseExists, RELEASE_EXISTS_COMMAND } from './lib/health-release';
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
import { repoRoot } from './lib/run';

// The readers live in scripts/lib/health-readers.ts; these are re-exported so the checkup's public
// names are still one import away — the script and its tests read them from './health'.
export type {
  AlarmsRead,
  DemoShippedRead,
  DependabotRead,
  HealthOverrides,
  HealthReaders,
  LastTagRead,
  MainGreenRead,
  NpmTreeRead,
  StampedTaggedRead,
  TagRunsRead,
} from './lib/health-readers';
export { CI_ARGS, jsonDocument, TAG_RUN_ARGS, TAG_RUN_FIELDS } from './lib/health-readers';
export type { ReleaseExistsRead } from './lib/health-release';

const SCRIPT = 'health';

/** The one new code: a row's command answered nothing readable, so the whole checkup cannot answer. */
const unreadable = (row: string, command: string, detail: string): Finding => ({
  code: 'X_HEALTH_ROW_UNREADABLE',
  cause: `the ${row} row could not be read: ${command} — ${detail}`,
  fix: 'bun run scripts/health.ts --json',
  at: 'scripts/health.ts',
});

// Exported for the test that pins row 4's command against the awaiting_tag watch command the
// release-due rule emits: the two rows answer from ONE query, and a row's own command string is
// what its refusal quotes, so a reader can always re-run exactly what the row ran.
export const ROW_COMMANDS: Readonly<Record<RowId, string>> = {
  'main-green':
    'bun run x -- ci --workflow ci.yml --event push --branch main --json; git rev-parse origin/main',
  'last-tag-published':
    "git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main; git rev-parse <tag>^{commit}; gh run list --workflow release.yml --limit 1 --json conclusion,headBranch,event,headSha,url",
  'stamped-version-tagged': 'bun run scripts/release-due.ts --json',
  'tag-runs-ended-well': `gh run list --workflow release-tag.yml --limit 5 --json ${TAG_RUN_FIELDS}`,
  'npm-serves-tree': 'bun run scripts/registry-audit.ts --json',
  'automation-alarms':
    'gh issue list --state open --label registry-drift --json number,title,state,createdAt,updatedAt,url',
  'dependabot-not-stuck':
    'gh pr list --app dependabot --limit 5 --state open --json number,createdAt,updatedAt,statusCheckRollup',
  'demo-shipped':
    'gh run list --workflow deploy-social-demo.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt',
  'release-exists': RELEASE_EXISTS_COMMAND,
};

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

/**
 * A release-tag.yml run that has not completed — queued on the `release-tag` concurrency group, or
 * still in progress — carries no completion verdict: the row is unverdicted and the run is re-run,
 * never filed as a failure. `status` is the reading, not `conclusion`: a run whose status is not
 * `completed` is one thing whatever it concluded, and its evidence (the run's id, url, title, the
 * commit it ran at and its creation time) is what the filing quotes.
 */
const isPending = (run: RunRow): boolean => run.status !== undefined && run.status !== 'completed';

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
  // The rule judges a completion verdict, so a run that has not completed is handed to it with
  // its conclusion blanked: it cannot be a failure, and the rule reads it as a run still going.
  // Every other run keeps its own conclusion, so a run that DID complete and failed still files.
  const judged = runs.map((run) => (isPending(run) ? { ...run, conclusion: null } : run));
  const verdict = tagRunsVerdict({ runs: judged });
  const pending = judged.find(isPending);
  // A failed run that DID complete still files — the pending one beside it is not its excuse.
  if (pending === undefined || verdict.verdict === 'unhealthy') return verdict;
  // The pending run's own evidence is kept, so the filing can name the run that is waiting.
  return { ...verdict, ...pending };
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
 * rides in `data.rows`, and `data.healthy` is true only when all nine read `healthy`.
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
  await judge('release-exists', readers['release-exists'], judgeReleaseExists);

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
