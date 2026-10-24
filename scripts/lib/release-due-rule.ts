// The decision `scripts/release-due.ts` reports: given the commits since the last tag, the
// changelog's [Unreleased] and the clock, is a release due, of what kind, and if not, why not.
// Pure — git, the manifests and the clock are the caller's — so every branch is a fixture.

import type { Bump } from '../release';
import { nextVersion } from '../release';
import { BREAKING_ENTRY } from './changelog-format';
import {
  majorIssueTitle,
  openMajorIssue,
  openReleaseAsk,
  openReleaseBump,
  RELEASE_SUBJECT,
} from './release-subject';

export type { AskPr, OpenAsk, OpenBump, OpenMajorIssue } from './release-subject';
// The dedupes live beside the subjects they match on (`release-subject.ts`), one per reader; they
// are re-exported so this file stays the one module the release-due readers import them from.
export {
  askPrArgs,
  MAJOR_ISSUE_SUBJECT,
  majorIssueArgs,
  majorIssueTitle,
  openMajorIssue,
  openReleaseAsk,
  openReleaseBump,
  parsePrIssues,
  prTwin,
} from './release-subject';

/** Why a release is not due. A closed list: the bot and the docs branch on these words. */
export const NOT_DUE_REASONS = [
  'awaiting_tag',
  'nothing_ships',
  'major_needs_a_maintainer',
  'settling',
] as const;
export type NotDueReason = (typeof NOT_DUE_REASONS)[number];

export const DEFAULT_SETTLE_HOURS = 24;

/**
 * The `gh run list` query the `awaiting_tag` watch command runs: the release-tag workflow's five
 * newest runs, with the fields a filing needs — the run's status and conclusion, its id, its
 * title, the commit it ran at, its URL and when it was created. `event` and `headBranch` are gone:
 * this workflow runs on ONE trigger — ci.yml's completion on `main`
 * (`.github/workflows/release-tag.yml:29-32`) — so both carry the same word on every run of it,
 * while `headSha` names the commit a filing must quote. The same field set and order as the health
 * brief's `tag runs ended well` row, so one query answers both: a command that returned only a
 * status could not say WHICH run failed, or quote its URL in the ask.
 */
export const RELEASE_TAG_RUN_FIELDS =
  'status,conclusion,databaseId,displayTitle,headSha,url,createdAt';

/** The one command to watch while the merged release waits for its tag. */
export const AWAITING_TAG_COMMAND = `gh run list --workflow release-tag.yml --limit 5 --json ${RELEASE_TAG_RUN_FIELDS}`;

/** The author git records on a Dependabot squash merge. */
export const DEPENDABOT = 'dependabot[bot]';

export interface WindowCommit {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  /** Committer time, epoch seconds: on a squash merge, when it landed on main. */
  readonly committedAt: number;
  readonly files: readonly string[];
}

export interface ShippingCommit {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly committedAt: number;
  readonly packages: readonly string[];
}

export interface DueInput {
  /** The highest `v*` tag reachable from HEAD, without its `v`. */
  readonly tagged: string;
  /** The version the publishable manifests are stamped at. */
  readonly stamped: string;
  readonly commits: readonly WindowCommit[];
  /** `## [Unreleased]`'s body, placeholder removed. */
  readonly unreleased: string;
  readonly nowMs: number;
  readonly settleHours: number;
  /** The package a path ships in, or undefined — `release-due-ships.ts`. */
  readonly ships: (path: string) => string | undefined;
  /** Titles of currently OPEN GitHub issues, for the release-due dedupes: the ask's twin on a
   * `due` decision and the pending-major issue's twin on a `major_needs_a_maintainer` one.
   * Never read on any other decision.
   *
   * ABSENT means the lookup could not answer — a missing binary, a failed call, a timeout, an
   * unparseable answer — and an empty list means it answered with no open issue. The two are
   * different facts and the major branch reads them differently: a `due` decision only ever
   * loses a twin note, but a `major_needs_a_maintainer` one FILES on the absence of a twin,
   * so there an absent list must not read as "none open" — that is how a `gh` outage becomes a
   * duplicate maintainer issue. */
  readonly openIssueTitles?: readonly string[];
  /** HEAD's SHA at the moment `decideAt` resolved the base ref. Pass-through only: the rule
   * never branches on it, so every existing fixture stays legal. */
  readonly headSha?: string;
  /** Titles of currently OPEN GitHub pull requests, for the bump-PR twin: merging an open
   * `chore: release <next>` PR IS the release, so nothing new is filed while one is open. Optional,
   * and absent whenever the lookup could not answer — no known PRs, never "none open". Only ever
   * read on a `due` decision. */
  readonly openPrTitles?: readonly string[];
}

export interface DueDecision {
  readonly due: boolean;
  readonly reason?: NotDueReason;
  readonly detail: string;
  readonly bump?: Bump;
  readonly next?: string;
  readonly shipping: readonly ShippingCommit[];
  /** Commits in the window that ship nothing (release commits excluded). */
  readonly inert: number;
  /** ISO-8601 UTC: when a settling window becomes due. */
  readonly dueAt?: string;
  /** The one command to run next. */
  readonly command?: string;
  /** What the releaser owes the changelog before running `command`. */
  readonly notes: readonly string[];
  /** Verbatim entries that triggered a major decision: `BREAKING —` lines from [Unreleased] and
   * `!:` shipping-commit subjects. Empty on every non-major decision. The release-due bot reads
   * this list instead of re-extracting the entries from `detail` prose on every firing. */
  readonly breaking: readonly string[];
  /** HEAD's SHA at the moment `decideAt` resolved the base ref. Pass-through only: the rule
   * never reads it. Undefined for a `releaseDue` unit test, defined for a real decision. */
  readonly headSha?: string;
}

/** Conventional `type(scope)!:` — a subject declaring itself breaking. */
const BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/;
const FEATURE_SUBJECT = /^feat(?:\([^)]*\))?:/;
/** `### Changed` is not here: 20.1.2 and 20.2.1 are patch releases that carry one. */
const MINOR_HEADING = /^### Added\b/m;

/** Semver as this repo practises it: `BREAKING —` or `!:` is major; `### Added`/feat is minor. */
export function bumpOf(unreleased: string, shipping: readonly ShippingCommit[]): Bump {
  const breaking =
    unreleased.split('\n').some((line) => BREAKING_ENTRY.test(line)) ||
    shipping.some((commit) => BREAKING_SUBJECT.test(commit.subject));
  if (breaking) return 'major';
  if (MINOR_HEADING.test(unreleased) || shipping.some((c) => FEATURE_SUBJECT.test(c.subject))) {
    return 'minor';
  }
  return 'patch';
}

/** The verbatim entries that triggered a major decision: `BREAKING —` lines from
 * [Unreleased], then `!:` shipping-commit subjects. Empty on every non-major decision, so callers
 * (the release-due bot) can read it directly instead of re-extracting from `detail` prose. */
function breakingEntries(
  unreleased: string,
  shipping: readonly ShippingCommit[],
): readonly string[] {
  const fromChangelog = unreleased.split('\n').filter((line) => BREAKING_ENTRY.test(line));
  const fromSubjects = shipping
    .filter((commit) => BREAKING_SUBJECT.test(commit.subject))
    .map((commit) => commit.subject);
  return [...fromChangelog, ...fromSubjects];
}

const isDependabotOnly = (shipping: readonly ShippingCommit[]): boolean =>
  shipping.length > 0 && shipping.every((commit) => commit.author === DEPENDABOT);

/** What [Unreleased] owes before the bump, since `release.ts` promotes it verbatim. */
function changelogNotes(unreleased: string, shipping: readonly ShippingCommit[]): string[] {
  if (unreleased !== '') return [];
  if (isDependabotOnly(shipping)) {
    return [
      'Dependabot-only window: [Unreleased] in CHANGELOG.md says nothing. Before bumping, add a `### Changed` entry under `## [Unreleased]` naming each bumped dependency and the version it moved to.',
    ];
  }
  return [
    '[Unreleased] in CHANGELOG.md is empty, so the release notes would be the commit subjects alone. Write them under `## [Unreleased]` before bumping.',
  ];
}

export function shippingCommits(input: DueInput): {
  readonly shipping: readonly ShippingCommit[];
  readonly inert: number;
} {
  const shipping: ShippingCommit[] = [];
  let inert = 0;
  for (const commit of input.commits) {
    if (RELEASE_SUBJECT.test(commit.subject)) continue;
    const packages = [...new Set(commit.files.flatMap((file) => input.ships(file) ?? []))].sort();
    if (packages.length === 0) {
      inert += 1;
      continue;
    }
    const { sha, subject, author, committedAt } = commit;
    shipping.push({ sha, subject, author, committedAt, packages });
  }
  return { shipping, inert };
}

export function releaseDue(input: DueInput): DueDecision {
  const { shipping, inert } = shippingCommits(input);
  const base = {
    shipping,
    inert,
    notes: [] as readonly string[],
    breaking: [] as readonly string[],
    // Pure pass-through: callers that pass `headSha` (the only caller is `decideAt`) see it on
    // every returned decision; existing fixtures without `headSha` keep their previous shape.
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
  };
  if (input.stamped !== input.tagged) {
    return {
      ...base,
      due: false,
      reason: 'awaiting_tag',
      detail: `the tree is stamped ${input.stamped} and the last tag is v${input.tagged}: the release PR merged, and release-tag.yml tags it once ci.yml passes on main`,
      command: AWAITING_TAG_COMMAND,
    };
  }
  if (shipping.length === 0) {
    return {
      ...base,
      due: false,
      reason: 'nothing_ships',
      detail: `${inert} commit(s) since v${input.tagged}, and none changes a file a published package packs`,
    };
  }
  const bump = bumpOf(input.unreleased, shipping);
  const next = nextVersion(input.stamped, bump);
  const notes = changelogNotes(input.unreleased, shipping);
  if (bump === 'major') {
    // The pending-major issue is its own subject, with its own dedupe: an open issue titled
    // exactly `Major release pending: <next>` is the maintainer ask already filed, so the box
    // files nothing; without one, the box files exactly one, under that exact title.
    //
    // An absent list is not that second case: it is the lookup COULD NOT ANSWER, so whether an
    // issue is open is unknown. The note must not claim a twin and must not name one to file —
    // the brief's row branches on "no open issue already says a major is pending", and an
    // unknown is not that. It names the check the releaser owes instead.
    const majorIssue =
      input.openIssueTitles === undefined ? undefined : openMajorIssue(input.openIssueTitles, next);
    const majorNote =
      majorIssue === undefined
        ? `; the open-issue lookup could not answer, so whether a pending-major issue is open is unknown: check \`${majorIssueTitle(next)}\` before filing one`
        : majorIssue.open
          ? `; a pending-major issue already open: ${majorIssue.twin}`
          : `; file one issue titled \`${majorIssueTitle(next)}\`, listing the breaking entries, for a maintainer`;
    return {
      ...base,
      bump,
      next,
      notes,
      breaking: breakingEntries(input.unreleased, shipping),
      due: false,
      reason: 'major_needs_a_maintainer',
      detail: `a breaking change is pending (a \`BREAKING —\` line under [Unreleased], or a \`!:\` subject): ${next} needs a maintainer to judge its wiki/Upgrading.md walkthrough${majorNote}`,
      command: `bun run scripts/release.ts --version ${next} --dry-run --json`,
    };
  }
  const oldest = Math.min(...shipping.map((commit) => commit.committedAt)) * 1000;
  const dueAtMs = oldest + input.settleHours * 3_600_000;
  if (input.nowMs < dueAtMs) {
    const dueAt = new Date(dueAtMs).toISOString();
    return {
      ...base,
      bump,
      next,
      notes,
      due: false,
      reason: 'settling',
      detail: `the oldest shipping commit is younger than ${input.settleHours}h, so its author may still release it: due at ${dueAt}`,
      dueAt,
    };
  }
  const ask = openReleaseAsk(input.openIssueTitles ?? [], next);
  const twinNote = ask.open ? `; an ask already open: ${ask.twin}` : '';
  // The PR-side twin, read through the same `RELEASE_SUBJECT` a release commit is: an open
  // `chore: release <next>` PR is that very bump in flight, so its note follows the ask's.
  const bumpPr = openReleaseBump(input.openPrTitles ?? [], next);
  const bumpNote = bumpPr.open ? `; a bump PR already open: ${bumpPr.twin}` : '';
  return {
    ...base,
    bump,
    next,
    notes,
    due: true,
    detail: `${shipping.length} shipping commit(s) since v${input.tagged}, the oldest shipping commit is ${Math.floor((input.nowMs - oldest) / 3_600_000)}h or older: ${bump} to ${next}${twinNote}${bumpNote}`,
    command: `bun run scripts/release.ts --version ${next}`,
  };
}
