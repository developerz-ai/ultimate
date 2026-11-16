// One scheduled workflow's health row, as data: the newest run of a workflow nothing else announces
// (no gate, no PR) read by one `gh run list`, judged green, red, still going, or stopped — a newest
// run older than the schedule's bound means GitHub stopped firing it. flake-hunt and bench are two
// specs of this one reader and judge, so the two rows cannot drift into two rules.

import type { RunRow } from './health-narrow';
import { jsonDocument, narrowRuns } from './health-narrow';
import type { RowId, RowVerdict } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';

const FIELDS = 'databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt';

/** What a scheduled row's reader answers: the parsed `gh run list` document, never re-shaped. */
export interface ScheduledRead {
  readonly runs: unknown;
}

export type GhRunner = (args: readonly string[], cwd: string) => Promise<RunResult>;

/** The words and bounds one scheduled workflow's row differs by; everything else is shared. */
export interface ScheduledSpec {
  readonly row: RowId;
  readonly workflow: string;
  /** A newest run older than this means the schedule stopped firing. */
  readonly staleMs: number;
  /** What a run is called in a reason: `flake hunt`, `bench run`. */
  readonly noun: string;
  readonly green: string;
  readonly stale: string;
  /** The command that restarts a stopped schedule. */
  readonly restart: string;
  /** The reason and fix for a completed run that ended neither green nor cancelled. */
  readonly red: (run: RunRow) => { readonly reason: string; readonly fix: string };
}

export interface ScheduledRow {
  readonly command: string;
  readonly reader: (root: string, ghRunner: GhRunner) => Promise<ScheduledRead>;
  readonly judge: (read: ScheduledRead, nowMs: number) => RowVerdict | Finding;
}

const fieldsOf = (run: RunRow): Partial<RowVerdict> => ({
  conclusion: run.conclusion,
  status: run.status,
  event: run.event,
  headBranch: run.headBranch,
  headSha: run.headSha,
  url: run.url,
  createdAt: run.createdAt,
  id: run.id,
  title: run.title,
});

/**
 * No run yet is NO VERDICT, never healthy: the workflow is scheduled, so its first firing will make
 * one, and a green answered over a workflow that never ran is the silent green the checkup refuses.
 */
export const scheduledRow = (spec: ScheduledSpec): ScheduledRow => {
  const args = ['run', 'list', '--workflow', spec.workflow, '--limit', '1', '--json', FIELDS];
  const command = `gh ${args.join(' ')}`;
  const judge = (read: ScheduledRead, nowMs: number): RowVerdict | Finding => {
    const base = { row: spec.row };
    if (!Array.isArray(read.runs) || narrowRuns(read.runs).length < read.runs.length) {
      return {
        code: 'X_HEALTH_ROW_UNREADABLE',
        cause: `the ${spec.row} row could not be read: ${command} — gh printed no JSON run list`,
        fix: 'bun run scripts/health.ts --json',
        at: 'scripts/health.ts',
      };
    }
    const run = narrowRuns(read.runs)[0];
    if (run === undefined) {
      return { ...base, verdict: 'unverdicted', reason: `${spec.workflow} has not run yet` };
    }
    const fields = fieldsOf(run);
    if (run.conclusion === null || run.conclusion === 'cancelled') {
      return {
        ...base,
        verdict: 'unverdicted',
        ...fields,
        reason: `the newest ${spec.noun} is ${run.conclusion ?? run.status ?? 'running'} — re-run before filing`,
      };
    }
    const age = nowMs - Date.parse(run.createdAt ?? '');
    if (!(age <= spec.staleMs)) {
      return {
        ...base,
        verdict: 'unhealthy',
        ...fields,
        reason: `${spec.stale} — ${spec.restart}`,
        fix: spec.restart,
      };
    }
    if (run.conclusion === 'success') {
      return { ...base, verdict: 'healthy', ...fields, reason: spec.green };
    }
    return { ...base, verdict: 'unhealthy', ...fields, ...spec.red(run) };
  };
  return {
    command,
    reader: async (root, ghRunner) => ({
      runs: jsonDocument((await ghRunner(args, root)).output),
    }),
    judge,
  };
};
