// The decision `scripts/release-due.ts` reports: given the commits since the last tag, the
// changelog's [Unreleased] and the clock, is a release due, of what kind, and if not, why not.
// Pure — git, the manifests and the clock are the caller's — so every branch is a fixture.

import type { Bump } from '../release';
import { nextVersion } from '../release';
import { BREAKING_ENTRY } from './changelog-format';
import { RELEASE_SUBJECT } from './release-subject';

/** Why a release is not due. A closed list: the bot and the docs branch on these words. */
export const NOT_DUE_REASONS = [
  'awaiting_tag',
  'nothing_ships',
  'major_needs_a_maintainer',
  'settling',
] as const;
export type NotDueReason = (typeof NOT_DUE_REASONS)[number];

export const DEFAULT_SETTLE_HOURS = 24;

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
  const base = { shipping, inert, notes: [] as readonly string[] };
  if (input.stamped !== input.tagged) {
    return {
      ...base,
      due: false,
      reason: 'awaiting_tag',
      detail: `the tree is stamped ${input.stamped} and the last tag is v${input.tagged}: the release PR merged, and release-tag.yml tags it once ci.yml passes on main`,
      command: 'gh run list --workflow release-tag.yml --limit 5',
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
    return {
      ...base,
      bump,
      next,
      notes,
      due: false,
      reason: 'major_needs_a_maintainer',
      detail: `a breaking change is pending (a \`BREAKING —\` line under [Unreleased], or a \`!:\` subject): ${next} needs a maintainer to judge its wiki/Upgrading.md walkthrough`,
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
  return {
    ...base,
    bump,
    next,
    notes,
    due: true,
    detail: `${shipping.length} shipping commit(s) since v${input.tagged}, unreleased for ${input.settleHours}h or more: ${bump} to ${next}`,
    command: `bun run scripts/release.ts --version ${next}`,
  };
}
