// The `next` lane's rule (wiki/Stability.md): when the major window is open and `next` exists, is
// green at its tip and carries a change `main` lacks, the next major is PROPOSED — `next` merged
// into `main` and bumped, as one pull request a person merges. It never cuts one. Pure: the
// lookups are the caller's, and asked only once the window is open.

import type { Changelog } from './changelog-sections';
import type { Finding } from './log';
import { majorWindowFindings, nextMajorWindow } from './major-window';
import { bumpBranch } from './release-preflight';
import { openReleaseBump } from './release-subject';
import { nextVersion } from './release-version';

/** Why no major is proposed. A closed list: the brief branches on these words. */
export const NEXT_LANE_REASONS = [
  'window_closed',
  'no_next',
  'not_ahead',
  'not_green',
  'cannot_tell',
  'proposal_open',
] as const;
export type NextLaneReason = (typeof NEXT_LANE_REASONS)[number];

/** The branch as GitHub answers it; `unreadable` is no answer, never "absent". */
export type NextBranch =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly sha: string }
  | { readonly kind: 'unreadable'; readonly why: string };

/** ci.yml at `next`'s tip: only `green` lets a proposal through. */
export type NextCi =
  | { readonly kind: 'green'; readonly url: string }
  | { readonly kind: 'red'; readonly conclusion: string; readonly url: string }
  | { readonly kind: 'running'; readonly url: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly why: string };

export interface NextFacts {
  readonly branch: NextBranch;
  /** Files `next` changes since its merge base with `main`; undefined when nobody could say. A
   * count of FILES, not commits: after a squashed major `next` keeps its old commits, and only an
   * empty diff says it holds nothing `main` lacks. */
  readonly changedFiles?: number;
  /** Commits on `main` that `next` lacks: the proposal's merge step carries them. */
  readonly behindMain?: number;
  readonly ci: NextCi;
  /** Open PR titles for the twin check; undefined when the lookup could not answer. */
  readonly openPrTitles?: readonly string[];
}

export interface NextLaneDecision {
  readonly propose: boolean;
  readonly reason?: NextLaneReason;
  /** The major the proposal would cut. */
  readonly version: string;
  readonly detail: string;
  /** `YYYY-MM-DD`: the day the window opens, when one is counted. */
  readonly windowOpensOn?: string;
  /** The bump's own refusal on a closed window: what `release.ts` would print. */
  readonly refusal?: Finding;
  readonly prTitle?: string;
  /** The proposal, one command per step; empty unless `propose`. No step merges, tags or publishes. */
  readonly steps: readonly string[];
}

const PR_BODY =
  'Merges next into main and cuts the major. Merge by hand, never automatically: only after seven green days of compat.yml and of the canary on next (wiki/Stability.md). After the tag, restart next from main.';

/** The one pull request: `next` merged with `main`, bumped, pushed and proposed. `version` is a
 * computed `X.0.0`, so nothing here needs shell quoting beyond the fixed strings. */
export const proposalSteps = (version: string): readonly string[] => {
  const branch = bumpBranch(version);
  return [
    'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/heads/next:refs/remotes/origin/next',
    `git switch -c ${branch} origin/next`,
    'git merge --no-edit origin/main',
    `bun run scripts/release.ts --version ${version}`,
    'bun run verify',
    `git push origin ${branch}`,
    `gh pr create --base main --head ${branch} --title 'chore: release ${version}' --body '${PR_BODY}'`,
  ];
};

const notProposed = (
  version: string,
  reason: NextLaneReason,
  detail: string,
  windowOpensOn: string | undefined,
): NextLaneDecision => ({
  propose: false,
  reason,
  version,
  detail,
  steps: [],
  ...(windowOpensOn === undefined ? {} : { windowOpensOn }),
});

/** Why `facts` hold the proposal back, or undefined when they let it through. */
function holdBack(
  facts: NextFacts,
  version: string,
): readonly [NextLaneReason, string] | undefined {
  const { branch, ci } = facts;
  if (branch.kind === 'absent') {
    return ['no_next', 'no `next` branch on origin: every break waits there (wiki/Stability.md)'];
  }
  if (branch.kind === 'unreadable') return ['cannot_tell', `the next branch lookup: ${branch.why}`];
  if (facts.changedFiles === undefined) {
    return ['cannot_tell', 'the main...next compare could not answer'];
  }
  if (facts.changedFiles === 0) return ['not_ahead', '`next` changes no file `main` lacks'];
  if (ci.kind === 'unreadable') return ['cannot_tell', `the ci.yml run lookup: ${ci.why}`];
  if (ci.kind === 'none') {
    return ['not_green', `no ci.yml run at next's tip ${branch.sha.slice(0, 12)}`];
  }
  if (ci.kind === 'running')
    return ['not_green', `ci.yml is still running at next's tip: ${ci.url}`];
  if (ci.kind === 'red') {
    return ['not_green', `ci.yml concluded ${ci.conclusion} at next's tip: ${ci.url}`];
  }
  if (facts.openPrTitles === undefined) {
    return [
      'cannot_tell',
      `the open-PR lookup could not answer: check \`chore: release ${version}\` by hand`,
    ];
  }
  const twin = openReleaseBump(facts.openPrTitles, version);
  if (twin.open) return ['proposal_open', `the proposal is already open: ${twin.twin}`];
  return undefined;
}

/**
 * The lane's answer. `facts` is a thunk because it costs network calls: a closed window refuses on
 * the changelog alone — the same `majorWindowFindings` `release.ts` refuses the bump with.
 */
export async function nextLane(input: {
  readonly stamped: string;
  readonly changelog: Changelog;
  readonly today: string;
  /** Asked with the major the proposal would cut: its bump PR is the twin. */
  readonly facts: (version: string) => NextFacts | Promise<NextFacts>;
}): Promise<NextLaneDecision> {
  const version = nextVersion(input.stamped, 'major');
  const opensOn = nextMajorWindow(input.changelog)?.opensOn;
  const [refusal] = majorWindowFindings({
    version,
    changelog: input.changelog,
    today: input.today,
  });
  if (refusal !== undefined) {
    return {
      ...notProposed(
        version,
        'window_closed',
        `the major window is closed: ${refusal.cause}`,
        opensOn,
      ),
      refusal,
    };
  }
  const facts = await input.facts(version);
  const held = holdBack(facts, version);
  if (held !== undefined) return notProposed(version, held[0], held[1], opensOn);
  const behind = facts.behindMain ?? 0;
  const merge = behind > 0 ? `; ${behind} commit(s) behind main, which the merge step carries` : '';
  return {
    propose: true,
    version,
    detail: `the window is open and next is green and ahead (${facts.changedFiles} file(s)): propose ${version} as one PR${merge}`,
    prTitle: `chore: release ${version}`,
    steps: proposalSteps(version),
    ...(opensOn === undefined ? {} : { windowOpensOn: opensOn }),
  };
}
