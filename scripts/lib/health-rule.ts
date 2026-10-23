// The nine per-row health verdicts, pure: typed inputs in, one RowVerdict out — no subprocess, no
// Bun.* anywhere, so scripts/health.ts reads and this file judges; the document shapes it judges
// over live in health-narrow.ts. `unverdicted` always means "no verdict yet — re-run, never
// unhealthy": an ask filed over an unread world is the false alarm this rule exists to prevent.

import type { AlarmIssue, AuditDoc, CiDoc, DependabotPr, PrCheck, RunRow } from './health-narrow';

/** The three ways a row can answer. `unverdicted` is a re-run, never a filing. */
export type Verdict = 'healthy' | 'unhealthy' | 'unverdicted';

/** The rows, in the order `.dz/briefs/health.md`'s table defines them. */
export const ROW_IDS = [
  'main-green',
  'last-tag-published',
  'stamped-version-tagged',
  'tag-runs-ended-well',
  'npm-serves-tree',
  'automation-alarms',
  'dependabot-not-stuck',
  'demo-shipped',
  'release-exists',
] as const;

export type RowId = (typeof ROW_IDS)[number];

/** One row's answer, with the fields an ask's body quotes, per the brief's table. */
export interface RowVerdict {
  readonly row: RowId;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly conclusion?: string | null;
  readonly status?: string | undefined;
  readonly headSha?: string | undefined;
  readonly expectedSha?: string;
  readonly event?: string | undefined;
  readonly url?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly id?: number | undefined;
  readonly title?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly latched?: boolean;
  readonly issues?: readonly AlarmIssue[];
  readonly prs?: readonly DependabotPr[];
  /** Row 9's own fields: the tag its Release names, whether it is a draft, and when it published. */
  readonly tagName?: string | undefined;
  readonly isDraft?: boolean | undefined;
  readonly publishedAt?: string | undefined;
}

// ——— The rules. ———

const fieldsOf = (run: RunRow): Partial<RowVerdict> => ({
  conclusion: run.conclusion,
  status: run.status,
  headSha: run.headSha,
  event: run.event,
  url: run.url,
  createdAt: run.createdAt,
  id: run.id,
  title: run.title,
  headBranch: run.headBranch,
});

export interface MainGreenInput {
  readonly ci: CiDoc;
  readonly expectedSha: string;
}

/** Row 1. `success` at the origin/main tip is the only healthy answer; a running run is no verdict. */
export function mainGreenVerdict(input: MainGreenInput): RowVerdict {
  const base = { row: 'main-green' as const, expectedSha: input.expectedSha };
  const newest = input.ci.runs[0];
  if (newest === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: input.ci.runNotFound
        ? 'no ci.yml push run on main at all (X_CI_RUN_NOT_FOUND) — no verdict, never unhealthy; re-run before filing'
        : 'ci.yml has no push run on main to read — re-run before filing',
    };
  }
  const green = input.ci.runs.find((run) => run.conclusion === 'success');
  if (green === undefined) {
    if (newest.conclusion === null) {
      return {
        ...base,
        verdict: 'unverdicted',
        ...fieldsOf(newest),
        reason: `the newest push run is still ${newest.status ?? 'running'}, no verdict yet — re-run before filing`,
      };
    }
    return {
      ...base,
      verdict: 'unhealthy',
      ...fieldsOf(newest),
      reason: `main is red: the newest push run of ci.yml ended ${newest.conclusion}`,
    };
  }
  if (green.headSha !== input.expectedSha) {
    return {
      ...base,
      verdict: 'unhealthy',
      ...fieldsOf(green),
      reason: `ci.yml is green at ${green.headSha ?? 'an unreadable sha'}, not at the origin/main tip ${input.expectedSha} — the tip itself has no green run`,
    };
  }
  return {
    ...base,
    verdict: 'healthy',
    ...fieldsOf(green),
    reason: 'the newest ci.yml push run is success at the origin/main tip',
  };
}

export interface LastTagInput {
  readonly tagCommit: string;
  readonly run: RunRow | undefined;
}

/** Row 2. Match-only: a conclusion is read only off a run whose headSha IS the tag's peeled commit. */
export function lastTagVerdict(input: LastTagInput): RowVerdict {
  const base = { row: 'last-tag-published' as const, expectedSha: input.tagCommit };
  const run = input.run;
  if (run === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: 'release.yml has no run yet — no verdict from this row, never unhealthy',
    };
  }
  // The sha is the match, so a run that names none cannot be placed at the tag — its conclusion
  // reads as nothing: a `success` over an unmatched run would call a tag published on no evidence.
  if (run.headSha === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fieldsOf(run),
      reason: `the newest release.yml run names no headSha, so it cannot be matched to the tag's peeled commit — no verdict, re-run before filing`,
    };
  }
  if (run.headSha !== input.tagCommit) {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fieldsOf(run),
      reason: `the newest release.yml run is at another commit (${run.headSha}), not the tag's peeled commit — no verdict, re-run before filing`,
    };
  }
  if (run.conclusion === null) {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fieldsOf(run),
      reason: 'the newest release.yml run has not finished — re-run before filing',
    };
  }
  return {
    ...base,
    verdict: run.conclusion === 'success' ? 'healthy' : 'unhealthy',
    ...fieldsOf(run),
    reason:
      run.conclusion === 'success'
        ? 'the release.yml run at the tag peeled commit is success'
        : `the release.yml run at the tag peeled commit ended ${run.conclusion}`,
  };
}

export interface StampedTaggedInput {
  readonly lastTag: string | undefined;
  readonly reason: string | undefined;
}

/** Row 3. Only release-due's own answer reaches here; its refusal is the orchestrator's. */
export function stampedTaggedVerdict(input: StampedTaggedInput): RowVerdict {
  const base = { row: 'stamped-version-tagged' as const };
  if (input.reason === 'awaiting_tag') {
    return {
      ...base,
      verdict: 'unhealthy',
      reason: `release-due says the tree is awaiting its tag: a green release commit untagged is unhealthy whatever release-tag.yml returned`,
    };
  }
  if (input.lastTag === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: 'release-due answered without a last tag — re-run before filing',
    };
  }
  return {
    ...base,
    verdict: 'healthy',
    reason: `release-due answered: the tree is stamped and ${input.lastTag} is its tag, not awaiting one`,
  };
}

const BAD_RUN: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
]);

export interface TagRunsInput {
  readonly runs: readonly RunRow[];
}

/** Row 4. A failure, a cancel or a timeout is unhealthy; `skipped` is a non-release commit. */
export function tagRunsVerdict(input: TagRunsInput): RowVerdict {
  const base = { row: 'tag-runs-ended-well' as const };
  const bad = input.runs.find((run) => run.conclusion !== null && BAD_RUN.has(run.conclusion));
  if (bad !== undefined) {
    return {
      ...base,
      verdict: 'unhealthy',
      ...fieldsOf(bad),
      reason: `a release-tag.yml run ended ${bad.conclusion}`,
    };
  }
  const running = input.runs.find((run) => run.conclusion === null);
  if (running !== undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: `a release-tag.yml run is still ${running.status ?? 'running'} — re-run before filing`,
      conclusion: null,
      status: running.status,
    };
  }
  return {
    ...base,
    verdict: 'healthy',
    reason: `${input.runs.length} recent release-tag.yml run(s), none failure, cancelled, timed_out or startup_failure`,
  };
}

export interface NpmTreeInput {
  readonly audit: AuditDoc;
}

/** Row 5. The audit's own refusal is this row's unhealthy, not the script's; every field is re-read. */
export function npmTreeVerdict(input: NpmTreeInput): RowVerdict {
  const base = { row: 'npm-serves-tree' as const };
  const audit = input.audit;
  if (!audit.ok) {
    return {
      ...base,
      verdict: 'unhealthy',
      reason: `registry-audit refused (${audit.findings.join(', ') || 'no readable findings'}) — npm may not serve what the tree says`,
    };
  }
  if (audit.states.some((state) => state.tagged === undefined)) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason:
        'git declined to say whether the stamped version is tagged — no verdict, re-run before filing',
    };
  }
  for (const state of audit.states) {
    if (state.kind !== 'ok') {
      return { ...base, verdict: 'unhealthy', reason: `${state.name} is ${state.kind} on npm` };
    }
    if (state.latest !== state.version) {
      return {
        ...base,
        verdict: 'unhealthy',
        reason: `npm's latest for ${state.name} is ${state.latest ?? 'none'}, not this tree's ${state.version ?? 'unknown version'} (X_REGISTRY_LATEST_DRIFT: the set is split)`,
      };
    }
    if (state.tagged === false) {
      return {
        ...base,
        verdict: 'unhealthy',
        reason: `${state.name} is published and attested, but v${state.version ?? '?'} is not tagged on origin, so release-tag.yml never ran`,
      };
    }
  }
  return {
    ...base,
    verdict: 'healthy',
    reason: `npm serves all ${audit.states.length} publishable workspace(s) at this tree's versions, attested and tagged`,
  };
}

/** Today's 06:17 UTC audit instant — when registry-audit.yml re-fires or comments — from `nowMs`. */
export const todayAuditMs = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 17);
};

export interface AlarmsInput {
  readonly issues: readonly AlarmIssue[];
  readonly nowMs: number;
}

/** Row 6. Empty is healthy; otherwise unhealthy, each issue named latched or re-firing. */
export function alarmsVerdict(input: AlarmsInput): RowVerdict {
  const base = { row: 'automation-alarms' as const };
  if (input.issues.length === 0) {
    return { ...base, verdict: 'healthy', reason: 'no open registry-drift issue' };
  }
  const auditAt = todayAuditMs(input.nowMs);
  const issues = input.issues.map((issue) => {
    const updatedAt = Date.parse(issue.updatedAt ?? '');
    return { ...issue, latched: Number.isFinite(updatedAt) && updatedAt < auditAt };
  });
  return {
    ...base,
    verdict: 'unhealthy',
    reason: `${issues.length} open registry-drift alarm(s): ${issues
      .map(
        (one) =>
          `#${one.number}${one.latched ? " latched, newest comment predates today's 06:17 UTC audit" : " re-firing with today's audit"}`,
      )
      .join(', ')}`,
    latched: issues.every((one) => one.latched),
    issues,
  };
}

const WEEK_MS = 7 * 24 * 3_600_000;

export interface DependabotInput {
  readonly prs: readonly DependabotPr[];
  readonly nowMs: number;
}

// Row 7's check reading: red beats green beats pending, and an empty rollup is pending — gh
// unions CheckRun (status/conclusion) and StatusContext (state) entries in the one list.
type CheckReading = 'green' | 'red' | 'pending';

const RED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

const readCheck = (check: PrCheck): CheckReading => {
  const conclusion = check.conclusion?.toUpperCase();
  if (conclusion !== undefined && RED_CONCLUSIONS.has(conclusion)) return 'red';
  const state = check.state?.toUpperCase();
  if (state === 'FAILURE' || state === 'ERROR') return 'red';
  if (state === 'SUCCESS') return 'green';
  if (
    check.status?.toUpperCase() === 'COMPLETED' &&
    conclusion !== undefined &&
    GREEN_CONCLUSIONS.has(conclusion)
  ) {
    return 'green';
  }
  return 'pending';
};

/** A PR's whole rollup: any red entry is red, green needs every entry green, else pending. */
const rollupReading = (pr: DependabotPr): CheckReading => {
  const checks = pr.checks ?? [];
  if (checks.length === 0) return 'pending';
  const readings = checks.map(readCheck);
  if (readings.includes('red')) return 'red';
  return readings.every((reading) => reading === 'green') ? 'green' : 'pending';
};

/**
 * Row 7. Healthy with no open PR or none older than 7 days; past that the rollup decides — a
 * green 7+ day PR is stuck awaiting merge (merge it or close it), a red or pending one is stuck
 * on CI and the npm-bump ask applies. Both groups are classified before the row answers: a page
 * stuck both ways names both in one reason, so neither group's ask is dropped.
 */
export function dependabotVerdict(input: DependabotInput): RowVerdict {
  const base = { row: 'dependabot-not-stuck' as const };
  // `--state open` is the filter that makes "stuck" decidable: an entry gh returns with another
  // state contradicts it, and a merged or closed PR's createdAt is not an age.
  const open = input.prs.filter((pr) => pr.state === undefined || pr.state === 'OPEN');
  if (open.length === 0) {
    return { ...base, verdict: 'healthy', reason: 'no open Dependabot PR', prs: input.prs };
  }
  if (open.some((pr) => !Number.isFinite(Date.parse(pr.createdAt ?? '')))) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: 'gh returned a Dependabot PR without a readable createdAt — re-run before filing',
      prs: input.prs,
    };
  }
  const stuck = open.filter((pr) => input.nowMs - Date.parse(pr.createdAt ?? '') > WEEK_MS);
  if (stuck.length === 0) {
    return {
      ...base,
      verdict: 'healthy',
      reason: `${open.length} open Dependabot PR(s), none older than 7 days`,
      prs: input.prs,
    };
  }
  // Classify EVERY stuck PR before answering: one page can be stuck both ways at once, and an
  // early return on the first group found drops the other group's ask from the reason it files.
  const readings = stuck.map((pr) => ({ pr, reading: rollupReading(pr) }));
  const awaitingMerge = readings.filter((one) => one.reading === 'green');
  const onCi = readings.filter((one) => one.reading !== 'green');
  const groups: string[] = [];
  if (awaitingMerge.length > 0) {
    groups.push(
      `green and unmerged 7+ days — merge or close: ${awaitingMerge
        .map(
          ({ pr }) =>
            `#${pr.number} since ${pr.createdAt}${pr.autoMerge === true ? ' (auto-merge armed)' : ''}`,
        )
        .join(', ')}`,
    );
  }
  if (onCi.length > 0) {
    groups.push(
      `stuck on red or pending checks: ${onCi
        .map(({ pr }) => `#${pr.number} since ${pr.createdAt}`)
        .join(', ')} — the npm-bump ask applies`,
    );
  }
  return {
    ...base,
    verdict: 'unhealthy',
    reason: `Dependabot ${groups.join('; ')}`,
    prs: input.prs,
  };
}

export interface DemoShippedInput {
  readonly run: RunRow | undefined;
}

/** Row 8. Takes row 1's verdict: a skip under a red main is that row's ask alone, never a second one. */
export function demoShippedVerdict(input: DemoShippedInput, mainGreen: Verdict): RowVerdict {
  const base = { row: 'demo-shipped' as const };
  const run = input.run;
  if (run === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: 'deploy-social-demo.yml has no run yet — re-run before filing',
    };
  }
  const fields = fieldsOf(run);
  if (run.conclusion === null) {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fields,
      reason: `the newest demo deploy is still ${run.status ?? 'running'} — re-run before filing`,
    };
  }
  if (run.event === 'workflow_dispatch') {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fields,
      reason: `an operator started that run on ${run.headBranch ?? 'a ref'} — not a push publish, whatever its conclusion`,
    };
  }
  if (run.conclusion === 'success' && run.event === 'workflow_run') {
    return {
      ...base,
      verdict: 'healthy',
      ...fields,
      reason: 'a green push to main shipped the demo',
    };
  }
  if (run.conclusion === 'skipped') {
    if (mainGreen === 'healthy') {
      return {
        ...base,
        verdict: 'unhealthy',
        ...fields,
        reason:
          'the deploy job skipped: ci.yml completed without a green push (deploy-social-demo.yml:65-69) — check for a non-push ci.yml run',
      };
    }
    // One ask per unhealthy row: with main not green the skip is main's symptom, and the
    // main-green row already files it — a second unhealthy row here would file the ask twice.
    return {
      ...base,
      verdict: 'unverdicted',
      ...fields,
      reason:
        mainGreen === 'unhealthy'
          ? 'the deploy job skipped because main is not green — the main-green row files that ask alone; re-run this row once main is green'
          : 'the deploy job skipped while the main-green row has no verdict — re-run before filing',
    };
  }
  return {
    ...base,
    verdict: 'unhealthy',
    ...fields,
    reason: `the demo deploy ended ${run.conclusion} — name the guard the run log's ::error:: line names: the not-on-main-tip guard (deploy-social-demo.yml:99-115) or the app-gate-verdict guard (deploy-social-demo.yml:127-144)`,
  };
}
