// Which workflow runs `x ci` is about, and the three `gh run` calls that answer it. Selection
// lives here rather than in the command so "the latest run of each workflow on this branch" is one
// testable function over plain rows instead of a shape only a subprocess can produce.

import { t } from '@ultimat3/schema';
import type { GhHost } from './gh';
import { ghJson, runGh } from './gh';
import type { GhRepo } from './gh-target';

/** The fields both `gh run list` and `gh run view` accept, named once so the two agree. */
export const RUN_FIELDS =
  'databaseId,status,conclusion,headBranch,displayTitle,workflowName,url,createdAt';

const RUN_ROW = t.object({
  databaseId: t.number,
  status: t.string,
  conclusion: t.nullable(t.string),
  headBranch: t.string,
  displayTitle: t.string,
  workflowName: t.string,
  url: t.string,
  createdAt: t.string,
});

const STEP = t.object({ name: t.string, conclusion: t.nullable(t.string), number: t.number });

const JOB = t.object({
  name: t.string,
  status: t.string,
  conclusion: t.nullable(t.string),
  url: t.string,
  steps: t.array(STEP),
});

const RUN_LIST = t.array(RUN_ROW);
const RUN_VIEW = RUN_ROW.extend({ jobs: t.array(JOB) });

export interface CiStep {
  readonly name: string;
  readonly conclusion: string | null;
  readonly number: number;
}

export interface CiJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly steps: readonly CiStep[];
}

export interface CiRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly branch: string;
  readonly title: string;
  readonly workflow: string;
  readonly url: string;
  readonly createdAt: string;
}

/**
 * The conclusions that mean "this run is not green". `cancelled` and `timed_out` are in it because
 * a cancelled run has told the reader nothing about their change, and a command that reported it
 * as passing would be a green verdict over an unanswered question. `skipped` is not: a workflow
 * whose conditions did not match was never asked.
 */
export const FAILED_CONCLUSIONS: readonly string[] = [
  'failure',
  'cancelled',
  'timed_out',
  'startup_failure',
  'action_required',
  'stale',
];

export const isFailed = (run: CiRun): boolean =>
  run.conclusion !== null && FAILED_CONCLUSIONS.includes(run.conclusion);

export const isRunning = (run: CiRun): boolean => run.status !== 'completed';

interface RunRow {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headBranch: string;
  readonly displayTitle: string;
  readonly workflowName: string;
  readonly url: string;
  readonly createdAt: string;
}

const runOf = (row: RunRow): CiRun => ({
  id: row.databaseId,
  status: row.status,
  conclusion: row.conclusion,
  branch: row.headBranch,
  title: row.displayTitle,
  workflow: row.workflowName,
  url: row.url,
  createdAt: row.createdAt,
});

/**
 * The newest run of EACH workflow, which is the honest answer to "is CI green on this branch".
 * Taking the newest run overall reports whichever workflow happened to finish last — this repo
 * runs `ci` and `deploy-social-demo` off the same push, so half the time that is a verdict about
 * a workflow the caller was not asking about.
 */
export function latestPerWorkflow(runs: readonly CiRun[]): readonly CiRun[] {
  const newest = new Map<string, CiRun>();
  for (const run of runs) {
    const held = newest.get(run.workflow);
    if (held === undefined || run.createdAt > held.createdAt) newest.set(run.workflow, run);
  }
  return [...newest.values()];
}

export async function listRuns(
  host: GhHost,
  repo: GhRepo,
  branch: string,
  limit: number,
): Promise<readonly CiRun[]> {
  const rows = await ghJson(
    host,
    [
      'run',
      'list',
      '--repo',
      repo.slug,
      '--branch',
      branch,
      '--limit',
      String(limit),
      '--json',
      RUN_FIELDS,
    ],
    RUN_LIST,
    {
      label: `gh run list --branch ${branch}`,
      fix: `x ci --branch ${branch} --repo ${repo.slug} --json`,
    },
  );
  return rows.map(runOf);
}

/** One run, with its jobs — `gh run view --json` carries both, so this is one round trip. */
export async function viewRun(
  host: GhHost,
  repo: GhRepo,
  id: number,
): Promise<{ readonly run: CiRun; readonly jobs: readonly CiJob[] }> {
  const viewed = await ghJson(
    host,
    ['run', 'view', String(id), '--repo', repo.slug, '--json', `${RUN_FIELDS},jobs`],
    RUN_VIEW,
    { label: `gh run view ${id}`, fix: `x ci --run ${id} --repo ${repo.slug} --json` },
  );
  return { run: runOf(viewed), jobs: viewed.jobs };
}

/**
 * The failed steps' log, and only those. `--log` is the whole run — setup, caches, every green
 * step — where `--log-failed` is the part a triage starts from, which is the difference between
 * one command and three.
 */
export async function failedLog(host: GhHost, repo: GhRepo, id: number): Promise<string> {
  const result = await runGh(
    host,
    ['run', 'view', String(id), '--repo', repo.slug, '--log-failed'],
    {
      label: `gh run view ${id} --log-failed`,
      fix: `gh run view ${id} --repo ${repo.slug} --log   # the whole log, when the failed steps carry none`,
    },
  );
  return result.stdout;
}
