// Row 11's read, judge and command: whether the newest nightly `flake-hunt.yml` run — `unit` and
// `live` three times each in a shuffled order — ended green, and whether it is still running every
// night at all. Not a gate, so nothing else announces its red; this row is where it is read.

import type { RunRow } from './health-narrow';
import { jsonDocument, narrowRuns } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import { gh } from './release-due-gh';
import type { RunResult } from './run';

const FIELDS = 'databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt';
const ARGS = ['run', 'list', '--workflow', 'flake-hunt.yml', '--limit', '1', '--json', FIELDS];
/** Two nights: a newest run older than this means the schedule stopped firing. */
const STALE_MS = 48 * 60 * 60 * 1000;

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const FLAKE_HUNT_COMMAND = `gh ${ARGS.join(' ')}`;

export interface FlakeHuntRead {
  readonly runs: unknown;
}

export const flakeHuntReader = async (
  root: string,
  ghRunner: (args: readonly string[], cwd: string) => Promise<RunResult> = gh,
): Promise<FlakeHuntRead> => ({ runs: jsonDocument((await ghRunner(ARGS, root)).output) });

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
 * No run yet is NO VERDICT, never healthy: the workflow is scheduled, so the first night will make
 * one, and a green answered over a hunt that never ran is the silent green this checkup refuses.
 * A green run older than two nights is unhealthy — GitHub stops a schedule on its own.
 */
export const judgeFlakeHunt = (read: FlakeHuntRead, nowMs: number): RowVerdict | Finding => {
  const base = { row: 'flake-hunt' as const };
  if (!Array.isArray(read.runs) || narrowRuns(read.runs).length < read.runs.length) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the flake-hunt row could not be read: ${FLAKE_HUNT_COMMAND} — gh printed no JSON run list`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  const run = narrowRuns(read.runs)[0];
  if (run === undefined) {
    return { ...base, verdict: 'unverdicted', reason: 'flake-hunt.yml has not run yet' };
  }
  const fields = fieldsOf(run);
  if (run.conclusion === null || run.conclusion === 'cancelled') {
    return {
      ...base,
      verdict: 'unverdicted',
      ...fields,
      reason: `the newest flake hunt is ${run.conclusion ?? run.status ?? 'running'} — re-run before filing`,
    };
  }
  const age = nowMs - Date.parse(run.createdAt ?? '');
  if (!(age <= STALE_MS)) {
    return {
      ...base,
      verdict: 'unhealthy',
      ...fields,
      reason:
        'no flake hunt in two nights: the schedule stopped — gh workflow enable flake-hunt.yml && gh workflow run flake-hunt.yml',
    };
  }
  if (run.conclusion === 'success') {
    return {
      ...base,
      verdict: 'healthy',
      ...fields,
      reason: 'last night every shuffled round passed',
    };
  }
  return {
    ...base,
    verdict: 'unhealthy',
    ...fields,
    reason: `the newest flake hunt ended ${run.conclusion}: gh issue list --label flake-hunt --state open names each test, its seed and its rerun`,
  };
};
