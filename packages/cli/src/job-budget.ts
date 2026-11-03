// The `manifest` step's drain half: a job's declared `timeout` against what a deploy gives the worker
// holding it. Over that, the job is cut while still inside its own limit, on every deploy that
// lands during it. A job with no `timeout` is not graded: a limit nobody declared is not comparable.

import type { DrainConfig } from '@ultimat3/core';
import {
  APP_CONFIG_FILE,
  DRAIN_DEADLINE_DEFAULT_MS,
  finiteCount,
  isUltimateError,
  WORKER_DRAIN_DEADLINE_MAX_MS,
  WORKER_RETIRE_DEFAULT_MS,
} from '@ultimat3/core';
import { cutoffTimes, registeredJobs } from '@ultimat3/jobs';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';
import { loadDrainConfig } from './serve-drain';

/** The two facts graded; a job handle has both. */
export interface BudgetedJob {
  readonly name: string;
  readonly timeoutMs: number | undefined;
}

type WorkerDrain = Pick<Partial<DrainConfig>, 'deadlineMs' | 'workerDeadlineMs' | 'workerRetireMs'>;

/**
 * The retire when on, for it aborts nothing; else when a SIGTERM drain CANCELS a held job, which is
 * the cut-off's `cancelAt` (`worker-drain-cutoff.ts`), a margin before the deadline itself.
 */
export function workerBudgetMs(drain: WorkerDrain | undefined): number {
  // Screened here, not trusted: `defineConfig` screens an app's config, but this is exported, and a
  // NaN compares false against every timeout, which would grade every job as within budget.
  const retire = finiteCount(
    'the worker budget',
    'drain.workerRetireMs',
    drain?.workerRetireMs ?? WORKER_RETIRE_DEFAULT_MS,
  );
  if (retire > 0) return retire;
  const deadline = finiteCount(
    'the worker budget',
    'drain.workerDeadlineMs',
    drain?.workerDeadlineMs ?? drain?.deadlineMs ?? DRAIN_DEADLINE_DEFAULT_MS,
    1,
  );
  return cutoffTimes(deadline, 0).cancelAt;
}

function outlastsFinding(job: BudgetedJob, limitMs: number, budgetMs: number): Finding {
  return {
    code: 'X_JOB_OUTLASTS_DRAIN',
    cause: `${job.name} declares a timeout of ${limitMs} ms, and the worker's budget is ${budgetMs} ms, so a deploy cuts it while it is inside its own limit`,
    // Past the ceiling no config value clears it, and a fix that cannot be applied is not a fix.
    fix:
      limitMs > WORKER_DRAIN_DEADLINE_MAX_MS
        ? `timeout: '24h',   // on job ${job.name}: past a day no budget can hold it, so move the rest into step.run() calls, then x verify --only manifest --json`
        : `drain: { workerRetireMs: ${limitMs} },   // in ${APP_CONFIG_FILE}, then x verify --only manifest --json`,
    at: APP_CONFIG_FILE,
  };
}

/** One finding per job over budget, sorted: the verdict never reads the registration order. */
export function jobBudgetFindings(
  jobs: readonly BudgetedJob[],
  drain: WorkerDrain | undefined,
): readonly Finding[] {
  const budgetMs = workerBudgetMs(drain);
  const findings: Finding[] = [];
  for (const job of [...jobs].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (job.timeoutMs !== undefined && job.timeoutMs > budgetMs) {
      findings.push(outlastsFinding(job, job.timeoutMs, budgetMs));
    }
  }
  return findings;
}

/**
 * The step's answer: the registry once the app is loaded, as `job-registration.ts` reads it, and
 * nothing when the load or the config failed, for those are reported by what loaded them.
 */
export async function readJobBudgetFindings(
  root: string,
  load: AppLoader = loadApp,
): Promise<readonly Finding[]> {
  if ((await load(root)).findings.length > 0) return [];
  let drain: WorkerDrain | undefined;
  try {
    drain = await loadDrainConfig(root);
  } catch (error) {
    if (!isUltimateError(error) || error.code !== 'X_CONFIG_INVALID') throw error;
    return [];
  }
  return jobBudgetFindings(registeredJobs(), drain);
}
