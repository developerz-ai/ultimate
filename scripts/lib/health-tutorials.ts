// Row 10's read, judge and command: whether the newest `tutorial-run.yml` run — tutorials 1–4 run
// fence by fence on a scaffold of `main` — ended green. That workflow runs outside `ci` and on no
// PR, so nothing else announces its red; this row is where the daily checkup reads it.

import type { RunRow } from './health-narrow';
import { jsonDocument, narrowRuns } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import { gh } from './release-due-gh';
import type { RunResult } from './run';

const FIELDS = 'databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt';
const ARGS = ['run', 'list', '--workflow', 'tutorial-run.yml', '--limit', '1', '--json', FIELDS];

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const TUTORIALS_RUN_COMMAND = `gh ${ARGS.join(' ')}`;

export interface TutorialsRunRead {
  readonly runs: unknown;
}

export const tutorialsRunReader = async (
  root: string,
  ghRunner: (args: readonly string[], cwd: string) => Promise<RunResult> = gh,
): Promise<TutorialsRunRead> => ({ runs: jsonDocument((await ghRunner(ARGS, root)).output) });

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
 * No run at all is HEALTHY, not a re-run: the workflow is paths-filtered, so until a push touches
 * a tutorial or a generator there is nothing to have diverged, and re-running the query cannot
 * make a run exist. A cancelled newest run was superseded (`cancel-in-progress`): no verdict.
 */
export const judgeTutorialsRun = (read: TutorialsRunRead): RowVerdict | Finding => {
  const base = { row: 'tutorials-run' as const };
  if (!Array.isArray(read.runs) || narrowRuns(read.runs).length < read.runs.length) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the tutorials-run row could not be read: ${TUTORIALS_RUN_COMMAND} — gh printed no JSON run list`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  const run = narrowRuns(read.runs)[0];
  if (run === undefined) {
    return {
      ...base,
      verdict: 'healthy',
      reason:
        'tutorial-run.yml has no run yet: no push to main has touched a tutorial or a generator',
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
