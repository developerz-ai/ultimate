#!/usr/bin/env bun
// Answer, read-only, whether a release is due: commits since the last `v*` tag that change a file a
// published package packs, judged against [Unreleased] and a settle window. So the bot releases
// only what no maintainer released at once, and never a major on its own judgement.
//
//   bun run scripts/release-due.ts [--settle-hours 24] [--json]

import { flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { git } from './lib/release-due-git';
import type { DueDecision, WindowCommit } from './lib/release-due-rule';
import { DEFAULT_SETTLE_HOURS, releaseDue } from './lib/release-due-rule';
import { packageFiles, shippingPackage } from './lib/release-due-ships';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { listWorkspaces, publishFloorFindings, publishOrder } from './lib/workspaces';
import { sectionBody, UNRELEASED_VERSION } from './release-notes';

const SCRIPT = 'release-due';
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
// Record and field separators no subject or path contains, so a `|` in a subject splits nothing.
const RECORD = '\x1e';
const FIELD = '\x1f';

/** git could not answer — failed or timed out: what was asked is unknown, never "none". */
const gitUnreadable = (asked: string, output: string): Finding => ({
  code: 'X_RELEASE_WINDOW_UNREADABLE',
  cause: `${asked} failed, so the commits since the last release are unknown: ${output.slice(0, 300)}`,
  fix: 'git fetch --unshallow --tags origin; bun run scripts/release-due.ts --json',
  at: 'scripts/release-due.ts',
});

/**
 * The highest stable `v*` tag HEAD contains, without its `v`; undefined when there is none; a
 * finding when git itself could not answer, which is not the same as a tagless clone.
 */
export async function lastReleaseTag(root: string): Promise<string | undefined | Finding> {
  const tags = await git(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], root);
  if (!tags.ok) return gitUnreadable('git tag --merged HEAD', tags.output);
  for (const line of tags.output.split('\n')) {
    const version = STABLE_TAG.exec(line.trim())?.[1];
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * `git log` of the window, merges skipped (their parents are listed). `--no-renames` is what lists
 * BOTH ends of a rename — a delete of the old path and an add of the new — where rename detection
 * would list only the new one, and a file moved out of `packages/<pkg>/src` would ship nothing.
 */
export const windowLogArgs = (tag: string): readonly string[] => [
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

const unreachable = (): Finding => ({
  code: 'X_RELEASE_TAG_UNREACHABLE',
  cause:
    'no vX.Y.Z tag is reachable from HEAD, so there is no last release to count commits from — a shallow or tagless clone',
  fix: 'git fetch --tags origin && bun run scripts/release-due.ts --json',
  at: 'scripts/release-due.ts',
});

/**
 * The commits since `v<tagged>`, or the refusal when git could not list them. A different code
 * from a missing tag: the tag WAS found, so fetching tags fixes nothing — a clone too shallow to
 * hold the range between the tag and HEAD does, which `--unshallow` fetches (and errors on, harmlessly,
 * in a full clone, hence the `;`).
 */
export async function readWindow(
  root: string,
  tagged: string,
): Promise<readonly WindowCommit[] | Finding> {
  const log = await git(windowLogArgs(tagged), root);
  return log.ok
    ? parseWindowLog(log.output)
    : gitUnreadable(`git log v${tagged}..HEAD`, log.output);
}

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
  const publishable = publishOrder(workspaces);
  // The version is read, never invented: no publishable workspace is the publish-floor refusal.
  const [floor] = publishFloorFindings(workspaces);
  if (floor !== undefined) return floor;
  const stamped = publishable[0]?.version;
  if (stamped === undefined) {
    // The floor above refuses exactly this tree, so reaching here is a broken invariant.
    throw new ScriptError({
      code: 'X_CORPUS_UNSCANNED',
      cause: 'publishFloorFindings passed a tree with no publishable workspace',
      fix: 'bun run scripts/list-workspaces.ts --json',
    });
  }
  const tagged = await lastReleaseTag(root);
  if (tagged === undefined) return unreachable();
  if (typeof tagged !== 'string') return tagged;
  const commits = await readWindow(root, tagged);
  if ('code' in commits) return commits;
  const files = await packageFiles(publishable);
  const changelog = await Bun.file(`${root}/CHANGELOG.md`)
    .text()
    .catch(() => '');
  const decision = releaseDue({
    tagged,
    stamped,
    commits,
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
