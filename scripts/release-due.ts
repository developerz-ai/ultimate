#!/usr/bin/env bun
// Answer whether a release is due: commits since the last `v*` tag that change a file a
// published package packs, judged against [Unreleased] and a settle window. Fetches
// origin/main's tip when this checkout lacks it — so the bot releases only what no
// maintainer released at once, and never a major on its own judgement.
//
//   bun run scripts/release-due.ts [--settle-hours 24] [--json]

import { flagString, parseScriptArgs } from './lib/args';
import { BASE_REF, baseRef, FETCH_MAIN, type GitRunner } from './lib/base-ref';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { gh } from './lib/release-due-gh';
import { git } from './lib/release-due-git';
import type { DueDecision, DueInput, WindowCommit } from './lib/release-due-rule';
import {
  askPrArgs,
  DEFAULT_SETTLE_HOURS,
  majorIssueArgs,
  parsePrIssues,
  releaseDue,
} from './lib/release-due-rule';
import { packageFiles, shippingPackage } from './lib/release-due-ships';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { listWorkspaces, publishFloorFindings, publishOrder } from './lib/workspaces';
import type { TagProbe } from './registry-audit';
import { remoteTagProbe } from './registry-audit';
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

const unreachable = (): Finding => ({
  code: 'X_RELEASE_TAG_UNREACHABLE',
  cause:
    'no vX.Y.Z tag that origin also holds is reachable from HEAD, so there is no last release to count commits from — a shallow or tagless clone, or a remote that could not be asked',
  fix: 'git fetch --tags origin && bun run scripts/release-due.ts --json',
  at: 'scripts/release-due.ts',
});

/**
 * HEAD is not the tip of the base ref. `fetch` is the cause `baseRef()` returned undefined: the
 * fetch in `base-ref.ts` failed and the base is therefore unreachable. `mismatch` is the cause
 * `git rev-parse HEAD` and the base-ref SHA disagreed — HEAD is on a side branch (or
 * ahead of the base) and the answer a release-due consumer reads would be anchored to neither.
 * The fix is the same in both: bring the base back and move HEAD to it.
 */
const headNotMain = (
  headSha: string,
  baseSha: string,
  headBranch: string,
  kind: 'fetch' | 'mismatch',
): Finding => ({
  code: 'X_RELEASE_HEAD_NOT_MAIN',
  cause:
    kind === 'fetch'
      ? `${BASE_REF} is unreachable from HEAD, so the script cannot tell what HEAD is anchored to: ${FETCH_MAIN} failed`
      : `HEAD is at ${headSha} on branch ${headBranch}, but ${BASE_REF} is at ${baseSha}: HEAD is not the tip of ${BASE_REF}`,
  fix: `${FETCH_MAIN} && git checkout main`,
  at: 'scripts/release-due.ts',
});

/**
 * The highest stable `v*` tag HEAD contains that the REMOTE also holds, without its `v`; undefined
 * when there is none; a finding when git itself could not answer, which is not the same as a
 * tagless clone.
 *
 * A tag the remote cannot confirm is not a release: this answers whether a release is DUE, and a
 * window counted from a tag the remote never saw would report a maintainer's release as shipping
 * commits all over again. `probe` is injected like every other seam here — a test that reached
 * `origin` would report the remote's state, not this checkout's.
 *
 * `undefined` from the probe STOPS the scan; it does not step over the candidate. Whether the
 * higher tag is on origin is then unknown, and every tag below it is a DIFFERENT release whose
 * window this cannot honestly count — falling through would answer the question from a release
 * older than the one in doubt, a window stretched across a release the maintainer already shipped.
 */
export async function lastReleaseTag(
  root: string,
  probe: TagProbe = remoteTagProbe(root),
): Promise<string | undefined | Finding> {
  const tags = await git(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], root);
  if (!tags.ok) return gitUnreadable('git tag --merged HEAD', tags.output);
  for (const line of tags.output.split('\n')) {
    const version = STABLE_TAG.exec(line.trim())?.[1];
    if (version === undefined) continue;
    const onRemote = await probe(`v${version}`);
    // git's no-answer, not a denial: refuse rather than fall through to an older release.
    if (onRemote === undefined) return unreachable();
    if (onRemote === true) return version;
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

/** A `baseRef` runner that drops the leading 'git' and delegates to release-due-git's `git` —
 * same cwd, GIT_TIMEOUT_MS (30 s, well under `run()`'s 120 s), and an env stripped of every
 * `GIT_*` so an exported `GIT_DIR` cannot redirect the base-ref resolve into another repo. */
const baseRefRunner: GitRunner = (command, { cwd }) => {
  const [, ...args] = command;
  return git(args, cwd);
};

/**
 * The open bump PRs for `version`, best effort and last. A CLI that errors, times out or is not
 * installed answers NO KNOWN PRs, never "none open" as a fact — exactly how `scripts/release.ts`
 * reads its own lookup — so the twin note is simply absent and the decision is otherwise unchanged.
 */
export async function openPrTitlesAt(root: string, version: string): Promise<readonly string[]> {
  const listed = await gh(askPrArgs(version), root).catch(() => undefined);
  if (listed?.ok !== true) return [];
  return parsePrIssues(listed.output).map((pr) => pr.title);
}

/**
 * The open pending-major issues for `version`, best effort and last. Its own query, not the
 * ask's: the ask's search is `Release <version> in:title`, which never returns a
 * `Major release pending: <version>` title, so one list could not serve both subjects.
 *
 * `undefined` when the lookup COULD NOT ANSWER — the CLI missing, failing, timing out, or
 * answering with a body that is not the promised rows — and the titles when it did, an empty
 * list included. The difference is the whole point: an empty list says no issue is open, and
 * the rule files exactly one; `undefined` says nobody knows, and the rule must not file one,
 * because a second maintainer issue for the same major is worse than none.
 */
export async function openIssueTitlesAt(
  root: string,
  version: string,
): Promise<readonly string[] | undefined> {
  const listed = await gh(majorIssueArgs(version), root).catch(() => undefined);
  if (listed?.ok !== true) return undefined;
  // `parsePrIssues` is tolerant by contract: a body that is not rows at all reads as `[]`, and
  // `[]` reads as "none open". Here the two are different facts, so the shape is probed first
  // — the `bump-pr.ts` pattern.
  let rows: unknown;
  try {
    rows = JSON.parse(listed.output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  return parsePrIssues(listed.output).map((issue) => issue.title);
}

/**
 * Everything the rule needs, read from the checkout at `root`; a finding when it cannot be read.
 * Three seams, in that order: `probe` says whether origin holds a candidate tag (see
 * `lastReleaseTag`), `listPrTitles` is the bump-PR twin lookup and `listIssueTitles` is the
 * pending-major issue's twin lookup — all injected so a test names the answer instead of reaching
 * the remote or the GitHub CLI. `listIssueTitles` answers `undefined` when the lookup could not
 * answer, and that answer reaches the rule unchanged.
 */
export async function decideAt(
  root: string,
  settleHours: number,
  nowMs: number,
  probe: TagProbe = remoteTagProbe(root),
  listPrTitles: (version: string) => Promise<readonly string[]> = (version) =>
    openPrTitlesAt(root, version),
  listIssueTitles: (version: string) => Promise<readonly string[] | undefined> = (version) =>
    openIssueTitlesAt(root, version),
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
  const tagged = await lastReleaseTag(root, probe);
  if (tagged === undefined) return unreachable();
  if (typeof tagged !== 'string') return tagged;
  const commits = await readWindow(root, tagged);
  if ('code' in commits) return commits;
  // The base ref is the concrete anchor a `data.headSha` consumer compares against; if the
  // fetch in `baseRef()` failed, or HEAD is on a side branch, refuse with the same code so the
  // script's answer is always anchored to the base ref's tip. Runs after the existing
  // tag/window refusals so their codes keep their meaning.
  if ((await baseRef(root, baseRefRunner)) === undefined) return headNotMain('', '', '', 'fetch');
  const headRes = await git(['rev-parse', '--verify', 'HEAD'], root);
  if (!headRes.ok) return gitUnreadable('git rev-parse HEAD', headRes.output);
  const baseRes = await git(['rev-parse', '--verify', BASE_REF], root);
  if (!baseRes.ok) return gitUnreadable(`git rev-parse ${BASE_REF}`, baseRes.output);
  const headSha = headRes.output.trim();
  const baseSha = baseRes.output.trim();
  if (headSha !== baseSha) {
    const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const headBranch = branchRes.ok ? branchRes.output.trim() : '?';
    return headNotMain(headSha, baseSha, headBranch, 'mismatch');
  }
  const files = await packageFiles(publishable);
  const changelog = await Bun.file(`${root}/CHANGELOG.md`)
    .text()
    .catch(() => '');
  const facts: DueInput = {
    tagged,
    stamped,
    commits,
    unreleased: sectionBody(changelog, UNRELEASED_VERSION) ?? '',
    nowMs,
    settleHours,
    ships: (path) => shippingPackage(path, files),
    headSha,
  };
  // The rule computes `next`, so the lookups can only follow it. `releaseDue` is pure and cheap,
  // and only a `due` decision ever reads a twin, so the second pass happens on that path.
  const first = releaseDue(facts);
  const next = first.next;
  const openPrTitles = first.due && next !== undefined ? await listPrTitles(next) : [];
  // The pending-major issue's twin lives on the `major_needs_a_maintainer` path, which is not a
  // `due` decision — the same two-pass shape, one pass for each twin.
  //
  // `undefined` here means the lookup could NOT ANSWER, and it stays `undefined` all the way
  // into the rule: an empty list would read as "none open", which on this path is the one
  // answer that makes the box file a second maintainer issue for the same major.
  const major = first.reason === 'major_needs_a_maintainer';
  const openIssueTitles = major && next !== undefined ? await listIssueTitles(next) : undefined;
  // The second pass runs whenever a lookup ran at all. `first` was computed with no issue list
  // and no PR list, so on the major path it cannot know whether a twin is open — the same
  // reason the PR path re-runs.
  const decision =
    openPrTitles.length === 0 && !major
      ? first
      : releaseDue({
          ...facts,
          openPrTitles,
          ...(openIssueTitles === undefined ? {} : { openIssueTitles }),
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
    ...(decision.headSha === undefined ? [] : [`  head      ${decision.headSha.slice(0, 12)}`]),
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
  const headSha = decision.headSha;
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: decision.due
        ? `a release is due: ${decision.detail}`
        : `no release due (${decision.reason}): ${decision.detail}`,
      lines: dueLines(tagged, stamped, decision),
      data: { headSha, lastTag: `v${tagged}`, stamped, settleHours: settle, ...decision },
    },
    args.json,
  );
}
