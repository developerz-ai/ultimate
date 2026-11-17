// The report a bump that got past every refusal prints: what moved, what the derived writes did,
// and the ask this release would close. `ok` is the findings, never decoration.

import { CHART_FILE } from './chart-version';
import type { Finding, ScriptResult } from './lib/log';
import { securityLines } from './lib/major-window';
import { askIssueArgs, askLookupFailedLine, askTwin, parseAskIssues } from './lib/release-subject';
import { releaseNextLine } from './lib/release-text';
import {
  performedWriteLine,
  plannedWriteLine,
  RELEASE_WRITES,
  type ReleaseWrite,
} from './lib/release-writes';
import type { RunResult } from './lib/run';
import { STABILITY_PATH } from './lib/stability-findings';
import { type ApiLockOutcome, plannedApiLockLine } from './release-api-lock';

/** Everything the run decided and did, gathered before the report is written. */
export interface ReleaseDone {
  readonly version: string;
  readonly current: string;
  readonly publishable: readonly string[];
  readonly manifests: number;
  readonly published: number;
  readonly skew: readonly Finding[];
  readonly performed: {
    readonly writes: readonly ReleaseWrite[];
    readonly findings: readonly Finding[];
  };
  readonly apiLock: ApiLockOutcome | undefined;
  /** The subjects since the previous tag; `undefined` when this clone has no such tag. */
  readonly subjects: readonly string[] | undefined;
  readonly date: string;
  readonly dryRun: boolean;
  readonly rehearse: boolean;
  readonly security: string | undefined;
}

/** `gh`, already rooted at the repository; absent under `--rehearse`, which asks nobody. */
export type AskGh = (argv: readonly string[]) => Promise<RunResult>;

/**
 * The finished run's report. The ask lookup is best effort: by here the manifests are written, so
 * no answer from `gh` (absent binary, failed auth, timeout, garbage) may throw or touch `ok`. It
 * can only add the `Fixes #<n>` close link, or one line saying it could not confirm.
 */
export async function releaseDoneResult(
  done: ReleaseDone,
  gh: AskGh | undefined,
): Promise<ScriptResult> {
  const { version, current, dryRun, rehearse, security, performed, apiLock } = done;
  const lookup =
    gh === undefined
      ? undefined
      : await gh(['gh', ...askIssueArgs(version)]).catch(() => undefined);
  const openAsks = lookup?.ok === true ? parseAskIssues(lookup.output) : undefined;
  const twin = openAsks === undefined ? undefined : askTwin(openAsks, version);
  const count = done.publishable.length;
  const commits = done.subjects?.length ?? 0;
  return {
    // `ok: true` unconditionally meant a run that reported real X_RELEASE_VERSION_SKEW still exited
    // 0. A write this run could not perform is a failing release, not a footnote: the tree it leaves
    // behind is the one the tag would be cut on, and the gate reads all three files.
    ok: done.skew.length === 0 && performed.findings.length === 0 && apiLock?.finding === undefined,
    script: 'release',
    summary: rehearse
      ? `rehearsed ${count} packages at ${version}, the changelog untouched — never commit this tree`
      : dryRun
        ? `would release ${count} packages at ${version}`
        : `${count} packages set to ${version}`,
    findings: [
      ...done.skew,
      ...performed.findings,
      ...(apiLock?.finding === undefined ? [] : [apiLock.finding]),
    ],
    lines: [
      `  version   ${current} -> ${version}`,
      `  packages  ${done.publishable.join(', ')}`,
      `  manifests ${done.manifests} rewritten (${done.published} published, the rest repinned)`,
      `  chart     ${CHART_FILE} version + appVersion -> ${version}`,
      `  changelog [Unreleased] promoted to docs/changelog/${version}.md, its row in CHANGELOG.md, a fresh [Unreleased]`,
      `  gaps      wiki/Known-Gaps.md \`main\` cells -> **${version}**`,
      `  stability ${STABILITY_PATH} next-window line from the promoted changelog`,
      // Every derived file either way, the API lock included: a dry run that listed only what it
      // would NOT do is how three derived files stayed invisible for nineteen majors.
      ...(dryRun
        ? [...RELEASE_WRITES.map(plannedWriteLine), plannedApiLockLine()]
        : [...performed.writes.map(performedWriteLine), apiLock?.line ?? '']),
      done.subjects !== undefined
        ? `  commits   ${commits} since v${current}, appended under ### Commits`
        : `  commits   none listed — this clone has no v${current} tag to bound the range`,
      ...securityLines(version, security),
      releaseNextLine(version, twin === undefined ? undefined : `Fixes #${twin.number}`),
      ...(twin === undefined && openAsks === undefined ? [askLookupFailedLine(version)] : []),
    ],
    data: {
      version,
      previous: current,
      packages: done.publishable,
      manifests: done.manifests,
      commits,
      previousTagFound: done.subjects !== undefined,
      changelogDate: done.date,
      dryRun,
      rehearse,
      ...(security === undefined ? {} : { security }),
      ...(twin === undefined ? {} : { openAsk: { number: twin.number, title: twin.title } }),
      writes: dryRun
        ? RELEASE_WRITES.map((spec) => ({ kind: spec.kind, at: spec.at, command: spec.command }))
        : performed.writes,
    },
  };
}
