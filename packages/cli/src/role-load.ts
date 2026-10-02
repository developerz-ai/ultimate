// What a container role imports of the app. `web`, `sync` and `replicator` answer for registries a
// request, a subscription or the WAL names — routes, queries, entities — so they import every
// module. `worker` and `scheduler` run jobs and tasks: they import the API index and every module
// that brings no document (a component, a stylesheet) with it, and nothing else.

// why: Bun ships no path API; the API index is named app-root-relative and imported absolute.
import { join, resolve } from 'node:path';
import type { Role } from '@ultimat3/core';
import { isJsonObject, logger, UltimateError } from '@ultimat3/core';
import { registeredJobs, registeredTasks } from '@ultimat3/jobs';
import type { AppScan } from './app-load';
import { scanAppModules } from './app-load';
import { API_INDEX } from './app-root';
import { createDocumentGraph } from './document-graph';

/** `everything`: the scan every tool runs. `background`: no document a job does not import. */
export type RoleLoad = 'everything' | 'background';

/**
 * Typed over `Role`, so a seventh role does not compile until somebody decides what it imports.
 * `migrate` never reaches a load — `runMigrations` reads SQL files — and says `everything` so a
 * caller that boots it by hand is given the whole app rather than a guess.
 */
const DECLARED: Readonly<Record<Role, RoleLoad>> = {
  web: 'everything',
  // A subscription names a live query, and a page module may export one.
  sync: 'everything',
  // The slot decodes every table an entity declares, wherever the entity is declared.
  replicator: 'everything',
  worker: 'background',
  scheduler: 'background',
  migrate: 'everything',
};

/** A `Map`, so the read below is an own-key lookup — never a member of `Object.prototype`. */
export const ROLE_LOADS: ReadonlyMap<Role, RoleLoad> = new Map(
  Object.entries(DECLARED) as [Role, RoleLoad][],
);

/** What `role` imports. A value that is no role — an untyped caller's — is given everything. */
export const roleLoadFor = (role: Role): RoleLoad => ROLE_LOADS.get(role) ?? 'everything';

/** The file the gate holds fresh (`manifest` step) and every image carries beside the source. */
const MANIFEST_FILE = 'x.manifest.json';

/**
 * A background load that left out a job or task the committed manifest names. Logged, never
 * thrown: the boot answers it by importing the rest of the app, so the role runs everything it
 * ran before — it only pays for the documents this load exists to leave out.
 */
export class RoleLoadIncompleteError extends UltimateError {
  constructor(input: { role: Role; missing: readonly string[] }) {
    super({
      code: 'X_ROLE_LOAD_INCOMPLETE',
      cause: `the ${input.role} role imported ${API_INDEX} and every module that reaches no component or stylesheet, and ${MANIFEST_FILE} names ${String(input.missing.length)} job(s) or task(s) that load did not register (${input.missing.join(', ')}), so the whole app was imported instead`,
      fix: `add import * as <module> from the file that declares it and <module> to jobs: [...] or tasks: [...] in ${API_INDEX}, then x manifest`,
      meta: { role: input.role, missing: input.missing },
    });
  }
}

/** `name` of every entry of one manifest list — `[]` for a list that is absent or malformed. */
function namesIn(manifest: Record<string, unknown>, key: 'jobs' | 'tasks'): readonly string[] {
  const list = manifest[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) =>
    isJsonObject(entry) && typeof entry['name'] === 'string' ? [entry['name']] : [],
  );
}

/**
 * Every job and task the committed manifest names that this process has not registered —
 * `undefined` when there is no manifest to check against, which is not the same answer as "none".
 */
export async function unregisteredFromManifest(
  root: string,
): Promise<readonly string[] | undefined> {
  const parsed: unknown = await Bun.file(join(root, MANIFEST_FILE))
    .json()
    .catch(() => undefined);
  if (!isJsonObject(parsed)) return undefined;
  const jobs = new Set(registeredJobs().map((job) => job.name));
  const tasks = new Set(registeredTasks().map((task) => task.name));
  return [
    ...namesIn(parsed, 'jobs').filter((name) => !jobs.has(name)),
    ...namesIn(parsed, 'tasks').filter((name) => !tasks.has(name)),
  ].sort();
}

/**
 * The background scan alone, with no proof and no fallback: the API index and every module that
 * brings no document. What a worker imports when nothing is wrong — and what the gate imports in a
 * child to compare against the whole app (`verify-role-load.ts`).
 */
export async function scanBackground(root: string): Promise<AppScan> {
  const index = resolve(root, API_INDEX);
  // why `require.cache`: Bun 1.4 lists every evaluated ES module there, by absolute path — the
  // same table `app-reload-graph.ts` evicts from.
  const loaded = (absolute: string): boolean => absolute in require.cache;
  const graph = createDocumentGraph(loaded);
  return scanAppModules(root, {
    track: false,
    // The index first (`appModulePaths` leads with it): what it imports is what the app runs.
    // Then every module already here, and every one that brings no document with it — a service,
    // a catalog, a storage declaration registers on import and no job names it.
    include: async (absolute) =>
      absolute === index || loaded(absolute) || !(await graph.reachesDocument(absolute)),
  });
}

/**
 * The background load, then the proof it was enough. A job runs by NAME — the queue row carries
 * it — so the one thing this load must not do is leave a named job unregistered. The gate already
 * requires every job and task to be named from a `defineApi()` call (`X_JOB_UNREGISTERED`); the
 * manifest is the list that call produced, and a name it holds that this load did not register is
 * answered by importing everything, loudly.
 */
async function loadBackground(root: string, role: Role): Promise<AppScan> {
  const scan = await scanBackground(root);
  const missing = await unregisteredFromManifest(root);
  if (missing !== undefined && missing.length === 0) return scan;
  if (missing === undefined) {
    logger.warn('ultimate role load unverified', {
      role,
      cause: `${MANIFEST_FILE} is absent or unreadable, so nothing names the jobs this role must run and the whole app was imported`,
      fix: 'x manifest',
    });
  } else {
    const error = new RoleLoadIncompleteError({ role, missing });
    logger.error(error.format(), { code: error.code, role, missing });
  }
  return scanAppModules(root, { track: false });
}

/**
 * What `serve-boot.ts` calls instead of `loadApp`: the scan a role needs and none of what a tool
 * reads from it afterwards — no reload graph, no error-code walk of the app's source.
 */
export async function loadAppForRole(root: string, role: Role): Promise<AppScan> {
  return roleLoadFor(role) === 'background'
    ? loadBackground(root, role)
    : scanAppModules(root, { track: false });
}
