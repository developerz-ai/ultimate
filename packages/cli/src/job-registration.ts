// The `manifest` step's job half: a job or a task still carrying the positional name `job()` or
// `task()` minted (`anonymous-job-2`) was never handed to `defineApi`. That name is what the queue
// row, `x.manifest.json`, `x jobs show` and every dead-letter trace carry, and it moves whenever the
// import order does — so a retry scheduled under one deploy's name lands on another deploy's job.

import { registeredJobs, registeredTasks } from '@ultimat3/jobs';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';

/** What `job()` and `task()` name a declaration nobody named (`packages/jobs/src/job.ts`). */
const POSITIONAL = /^anonymous-(job|task)-\d+$/;

/** Every registered job and task still under its positional name. */
export function positionalNames(
  names: readonly string[] = [...registeredJobs(), ...registeredTasks()].map((one) => one.name),
): readonly string[] {
  return names.filter((name) => POSITIONAL.test(name)).sort();
}

export function unregisteredJobFinding(name: string): Finding {
  const kind = name.startsWith('anonymous-task-') ? 'tasks' : 'jobs';
  return {
    code: 'X_JOB_UNREGISTERED',
    cause: `${name} is a ${kind === 'tasks' ? 'task' : 'job'} no defineApi() call names, so it carries the positional name ${kind === 'tasks' ? 'task()' : 'job()'} minted — on the queue row, in the manifest and in every dead-letter trace, and it moves when the import order does`,
    fix: `add import * as <module> from its file and <module> to ${kind}: [...] in apps/web/api/index.ts, then x manifest`,
    at: 'apps/web/api/index.ts',
  };
}

/**
 * The step's answer. Loads the app the way every other gate step does — the registries are only
 * whole after the scan — and says nothing when the load failed: a short registry is the load's
 * finding, reported by the step that loaded it.
 */
export async function unregisteredJobFindings(
  root: string,
  load: AppLoader = loadApp,
): Promise<readonly Finding[]> {
  if ((await load(root)).findings.length > 0) return [];
  return positionalNames().map(unregisteredJobFinding);
}
