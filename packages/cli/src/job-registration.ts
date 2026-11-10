// The `manifest` step's job half: a job or task under the positional name `job()`/`task()` minted
// (`anonymous-job-2`) was never handed to `defineApi`, and that name — on the queue row, the manifest
// and every dead-letter trace — moves with the import order (`X_JOB_UNREGISTERED`). And an entity
// declaring `partitionBy` with no `partitions()` job registered (`X_PARTITIONS_UNMAINTAINED`).

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { partitionedEntities, registeredJobs, registeredTasks } from '@ultimat3/jobs';
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
  return [
    ...positionalNames().map(unregisteredJobFinding),
    ...unmaintainedPartitionFindings(
      partitionedEntities().map((described) => described.table),
      registeredJobs(),
    ),
  ];
}

/** What a registered job has to look like for this rule: a name, and maybe a `.schedule` task. */
interface JobShape {
  readonly name: string;
  readonly schedule?: { readonly name: string };
}

/**
 * Recognised by SHAPE, so a renamed `partitions({ name })` counts: the handle carries the
 * `.schedule` task the factory minted, named `<job>.schedule`. Nothing else does — `consumer()`
 * carries `.supervisor`.
 */
const isPartitionsJob = (job: JobShape): boolean => job.schedule?.name === `${job.name}.schedule`;

/** Pure: the partitioned tables and the registered jobs in, one finding when none maintains them. */
export function unmaintainedPartitionFindings(
  tables: readonly string[],
  jobs: readonly JobShape[],
): readonly Finding[] {
  if (tables.length === 0 || jobs.some(isPartitionsJob)) return [];
  return [
    {
      code: 'X_PARTITIONS_UNMAINTAINED',
      cause: `${[...tables].sort().join(', ')} declare${tables.length === 1 ? 's' : ''} partitionBy and no partitions() job is registered: no partition is created ahead, so the first insert past the last migrated one fails, and retention never drops one`,
      fix: 'x verify --only manifest --json   # after exporting partitions() from @ultimat3/jobs in a module listed under jobs in apps/web/api/index.ts, and its .schedule under tasks',
      docs: ERROR_DOCS_URL,
      at: 'apps/web/api/index.ts',
    },
  ];
}
