// Row 10's read, judge and command: whether the newest `tutorial-run.yml` run on `main` — tutorials
// 1–4 run fence by fence on a scaffold of it, on a path-filtered push and weekly — ended green, and
// whether it ran this week at all. Outside `ci`, nothing else announces main's red. A pull
// request's run — a fork's branch may be named `main` too — is that pull request's: skipped.

import type { RunRow } from './health-narrow';
import { jsonDocument, narrowRuns } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import { gh } from './release-due-gh';
import type { RunResult } from './run';

const FIELDS = 'databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt';
const ARGS = [
  'run',
  'list',
  '--workflow',
  'tutorial-run.yml',
  '--branch',
  'main',
  '--limit',
  '20',
  '--json',
  FIELDS,
];

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const TUTORIALS_RUN_COMMAND = `gh ${ARGS.join(' ')}`;

export interface TutorialsRunRead {
  readonly runs: unknown;
}

export const tutorialsRunReader = async (
  root: string,
  ghRunner: (args: readonly string[], cwd: string) => Promise<RunResult> = gh,
): Promise<TutorialsRunRead> => ({ runs: jsonDocument((await ghRunner(ARGS, root)).output) });

/** The events that are main's own state: a merge, the weekly schedule, a dispatch on main. */
const MAIN_EVENTS: ReadonlySet<string> = new Set(['push', 'schedule', 'workflow_dispatch']);

/** A week and a day: the schedule fires weekly, and GitHub stops a schedule on its own. */
export const TUTORIALS_STALE_MS = 8 * 24 * 60 * 60 * 1000;

const RESTART =
  'gh workflow enable tutorial-run.yml && gh workflow run tutorial-run.yml --ref main';

const fieldsOf = (run: RunRow): Partial<RowVerdict> => ({
  conclusion: run.conclusion,
  status: run.status,
  event: run.event,
  headBranch: run.headBranch,
  url: run.url,
  createdAt: run.createdAt,
  id: run.id,
  title: run.title,
});

/**
 * No run at all is NO VERDICT: the weekly schedule makes one, and a green answered over a workflow
 * that never ran is the silent green the checkup refuses. A newest run older than a week and a day
 * is stale — every path filter can miss the change that moved a printed line. A cancelled newest
 * run was superseded (`cancel-in-progress`): no verdict.
 */
export const judgeTutorialsRun = (read: TutorialsRunRead, nowMs: number): RowVerdict | Finding => {
  const base = { row: 'tutorials-run' as const };
  if (!Array.isArray(read.runs) || narrowRuns(read.runs).length < read.runs.length) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the tutorials-run row could not be read: ${TUTORIALS_RUN_COMMAND} — gh printed no JSON run list`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  const run = narrowRuns(read.runs).find((each) => MAIN_EVENTS.has(each.event ?? ''));
  if (run === undefined) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: `tutorial-run.yml has no push, scheduled or dispatched run on main yet — ${RESTART}`,
    };
  }
  const fields = fieldsOf(run);
  if (run.conclusion === null || run.conclusion === 'cancelled') {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fields,
      reason: `the newest tutorial run is ${run.conclusion ?? run.status ?? 'running'} — re-run before filing`,
    };
  }
  const age = nowMs - Date.parse(run.createdAt ?? '');
  if (!(age <= TUTORIALS_STALE_MS)) {
    return {
      ...base,
      verdict: 'unhealthy',
      ...fields,
      reason: `no tutorial run on main in eight days: the weekly schedule stopped — ${RESTART}`,
      fix: RESTART,
    };
  }
  if (run.conclusion === 'success') {
    return {
      ...base,
      verdict: 'healthy',
      ...fields,
      reason: 'tutorials 1–4 ran as written on main',
    };
  }
  return {
    ...base,
    verdict: 'unhealthy',
    ...fields,
    reason: `the newest tutorial run ended ${run.conclusion}: a tutorial no longer runs as written (X_DOC_TUTORIAL_DIVERGED) — bun run scripts/tutorial-run.ts --json names the page and line`,
  };
};
