#!/usr/bin/env bun
// Answer, read-only, whether a release is due: commits since the last `v*` tag that change a file a
// published package packs, judged against [Unreleased] and a settle window. So the bot releases
// only what no maintainer released at once, and never a major on its own judgement.
//
//   bun run scripts/release-due.ts [--settle-hours 24] [--json]

import { flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { DueDecision, WindowCommit } from './lib/release-due-rule';
import { DEFAULT_SETTLE_HOURS, releaseDue } from './lib/release-due-rule';
import { packageFiles, shippingPackage } from './lib/release-due-ships';
import { repoRoot, run } from './lib/run';
import { listWorkspaces, publishFloorFindings, publishOrder } from './lib/workspaces';
import { sectionBody, UNRELEASED_VERSION } from './release-notes';

const SCRIPT = 'release-due';
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
// Record and field separators no subject or path contains, so a `|` in a subject splits nothing.
const RECORD = '\x1e';
const FIELD = '\x1f';

/** The highest stable `v*` tag HEAD contains, without its `v` — or undefined when there is none. */
export async function lastReleaseTag(root: string): Promise<string | undefined> {
  const tags = await run(['git', 'tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], {
    cwd: root,
  });
  if (!tags.ok) return undefined;
  for (const line of tags.output.split('\n')) {
    const version = STABLE_TAG.exec(line.trim())?.[1];
    if (version !== undefined) return version;
  }
  return undefined;
}

/** `git log` of the window, both ends of a rename, merges skipped (their parents are listed). */
export const windowLogCommand = (tag: string): readonly string[] => [
  'git',
  'log',
  '--no-merges',
  '--no-renames',
  '--name-only',
  `--format=${RECORD}%H${FIELD}%ct${FIELD}%an${FIELD}%s`,
  `v${tag}..HEAD`,
];

export function parseWindowLog(output: string): readonly WindowCommit[] {
  return output.split(RECORD).flatMap((record) => {
    const [head = '', ...files] = record.split('\n');
    const [sha, time, author, subject] = head.split(FIELD);
    if (sha === undefined || sha === '' || subject === undefined) return [];
    return [
      {
        sha,
        subject,
        author: author ?? '',
        committedAt: Number(time),
        files: files.map((file) => file.trim()).filter((file) => file !== ''),
      },
    ];
  });
}

const unreachable = (cause: string): Finding => ({
  code: 'X_RELEASE_TAG_UNREACHABLE',
  cause,
  fix: 'git fetch --tags origin && bun run scripts/release-due.ts --json',
  at: 'scripts/release-due.ts',
});

/** The settle window, refused unless a finite number of hours at or above zero. */
export function settleHoursOf(raw: string | undefined): number | Finding {
  if (raw === undefined) return DEFAULT_SETTLE_HOURS;
  const hours = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(hours) && hours >= 0) return hours;
  return {
    code: 'X_CLI_BAD_FLAG',
    cause: '--settle-hours must be a number of hours at or above 0',
    fix: 'bun run scripts/release-due.ts --settle-hours 24 --json',
    at: 'scripts/release-due.ts',
  };
}

/** Everything the rule needs, read from the checkout at `root`; a finding when it cannot be read. */
export async function decideAt(
  root: string,
  settleHours: number,
  nowMs: number,
): Promise<
  { readonly tagged: string; readonly stamped: string; readonly decision: DueDecision } | Finding
> {
  const workspaces = await listWorkspaces(root);
  const [floor] = publishFloorFindings(workspaces);
  if (floor !== undefined) return floor;
  const publishable = publishOrder(workspaces);
  const tagged = await lastReleaseTag(root);
  if (tagged === undefined) {
    return unreachable(
      'no vX.Y.Z tag is reachable from HEAD, so there is no last release to count commits from — a shallow or tagless clone',
    );
  }
  const log = await run(windowLogCommand(tagged), { cwd: root });
  if (!log.ok) return unreachable(`git log v${tagged}..HEAD failed: ${log.output.slice(0, 300)}`);
  const files = await packageFiles(publishable);
  const changelog = await Bun.file(`${root}/CHANGELOG.md`)
    .text()
    .catch(() => '');
  const stamped = publishable[0]?.version ?? '0.0.0';
  const decision = releaseDue({
    tagged,
    stamped,
    commits: parseWindowLog(log.output),
    unreleased: sectionBody(changelog, UNRELEASED_VERSION) ?? '',
    nowMs,
    settleHours,
    ships: (path) => shippingPackage(path, files),
  });
  return { tagged, stamped, decision };
}

/** The human rendering: one line per fact, then one per shipping commit. */
export function dueLines(
  tagged: string,
  stamped: string,
  decision: DueDecision,
): readonly string[] {
  return [
    `  last tag  v${tagged}, the tree stamped at ${stamped}`,
    `  window    ${decision.shipping.length} shipping, ${decision.inert} inert`,
    ...decision.shipping.map(
      (commit) =>
        `  ships     ${commit.sha.slice(0, 9)} ${commit.subject} [${commit.packages.join(', ')}]`,
    ),
    ...(decision.next === undefined ? [] : [`  next      ${decision.next} (${decision.bump})`]),
    ...decision.notes.map((note) => `  note      ${note}`),
    ...(decision.command === undefined ? [] : [`  run       ${decision.command}`]),
  ];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const settle = settleHoursOf(flagString(args, 'settle-hours'));
  if (typeof settle !== 'number') {
    report({ ok: false, script: SCRIPT, summary: 'refused', findings: [settle] }, args.json);
  }
  const read = await decideAt(repoRoot(), settle, Date.now());
  if (!('decision' in read)) {
    report({ ok: false, script: SCRIPT, summary: 'cannot tell', findings: [read] }, args.json);
  }
  const { tagged, stamped, decision } = read;
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: decision.due
        ? `a release is due: ${decision.detail}`
        : `no release due (${decision.reason}): ${decision.detail}`,
      lines: dueLines(tagged, stamped, decision),
      data: { lastTag: `v${tagged}`, stamped, settleHours: settle, ...decision },
    },
    args.json,
  );
}
