// The `manifest` step's job half: a job or task under the positional name `job()`/`task()` minted
// (`anonymous-job-2`) was never handed to `defineApi`, and that name — on the queue row, the manifest
// and every dead-letter trace — moves with the import order (`X_JOB_UNREGISTERED`). And an entity
// declaring `partitionBy` with no `partitions()` job registered (`X_PARTITIONS_UNMAINTAINED`).

// why: Bun ships no path API; `posix` because the fix prints an import specifier on every OS.
import { join, posix } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import {
  isJobHandle,
  isPartitionsJob,
  isTaskHandle,
  partitionedEntities,
  registeredJobs,
  registeredTasks,
} from '@ultimat3/jobs';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import { API_INDEX } from './app-root';
import type { Finding } from './output';

/** The load, plus the modules it imported: where a positional job's file is looked up. */
type JobAppLoader = (
  root: string,
) => Promise<Awaited<ReturnType<AppLoader>> & { readonly files?: readonly string[] }>;

/** What `job()` and `task()` name a declaration nobody named (`packages/jobs/src/job.ts`). */
const POSITIONAL = /^anonymous-(job|task)-\d+$/;

/** Every registered job and task still under its positional name. */
export function positionalNames(
  names: readonly string[] = [...registeredJobs(), ...registeredTasks()].map((one) => one.name),
): readonly string[] {
  return names.filter((name) => POSITIONAL.test(name)).sort();
}

/** `nudge-post` → `nudgePost`: the name the import line binds, a valid identifier either way. */
const moduleAlias = (file: string): string => {
  const base = posix.basename(file).replace(/\.tsx?$/, '');
  const [head = '', ...rest] = base.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  const alias = [head, ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1))].join(
    '',
  );
  return /^[A-Za-z_]/.test(alias) ? alias : `module${alias}`;
};

/** The import the API index needs, relative to it and without the extension. */
const importLine = (file: string, alias: string): string => {
  const path = posix.relative(posix.dirname(API_INDEX), file).replace(/\.tsx?$/, '');
  return `import * as ${alias} from '${path.startsWith('.') ? path : `./${path}`}';`;
};

/**
 * `file` is the module exporting the job, when one does: the positional name moves between runs, so
 * the path is the only thing that tells several agents in one checkout whose job this is.
 */
export function unregisteredJobFinding(name: string, file?: string): Finding {
  const task = name.startsWith('anonymous-task-');
  const alias = file === undefined ? '<module>' : moduleAlias(file);
  const line =
    file === undefined ? `import * as ${alias} from '<its file>';` : importLine(file, alias);
  const where = file === undefined ? '' : ` declared in ${file}`;
  return {
    code: 'X_JOB_UNREGISTERED',
    cause: `${name}${where} is a ${task ? 'task' : 'job'} no defineApi() call names, so it carries the positional name ${task ? 'task()' : 'job()'} minted — on the queue row, in the manifest and in every dead-letter trace, and it moves when the import order does`,
    fix: `${line}   // in ${API_INDEX}, and ${alias} added to ${task ? 'tasks' : 'jobs'}: [...] there — then x manifest`,
    at: file ?? API_INDEX,
  };
}

/**
 * Which loaded module exports each positional handle. The imports answer from the module cache: the
 * load just evaluated these files. A handle no module exports has no file to name.
 */
async function declaringFiles(
  root: string,
  files: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for (const file of files) {
    const module = (await import(join(root, file))) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (!isJobHandle(value) && !isTaskHandle(value)) continue;
      if (POSITIONAL.test(value.name) && !found.has(value.name)) found.set(value.name, file);
    }
  }
  return found;
}

/**
 * The step's answer. Loads the app the way every other gate step does — the registries are only
 * whole after the scan — and says nothing when the load failed: a short registry is the load's
 * finding, reported by the step that loaded it.
 */
export async function unregisteredJobFindings(
  root: string,
  load: JobAppLoader = loadApp,
): Promise<readonly Finding[]> {
  const app = await load(root);
  if (app.findings.length > 0) return [];
  const names = positionalNames();
  const files = names.length === 0 ? new Map() : await declaringFiles(root, app.files ?? []);
  return [
    ...names.map((name) => unregisteredJobFinding(name, files.get(name))),
    ...unmaintainedPartitionFindings(
      partitionedEntities().map((described) => described.table),
      registeredJobs(),
    ),
  ];
}

/**
 * Pure: the partitioned tables and the registered jobs in, one finding when none maintains them.
 * A maintainer is recognised by IDENTITY (`isPartitionsJob`), so a renamed `partitions({ name })`
 * counts and a `cronJob()` — the same `<job>.schedule` shape — does not.
 */
export function unmaintainedPartitionFindings(
  tables: readonly string[],
  jobs: readonly unknown[],
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
