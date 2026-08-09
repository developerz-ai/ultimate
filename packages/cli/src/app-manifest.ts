// `x.manifest.json`: the framework's registries projected by `@ultimat3/manifest`. The CLI
// supplies only the facts no registry holds — the app's name and version, the route table, which
// surface enforces each permission, and the error codes its workspaces export.

import { join } from 'node:path';
import { describeActions } from '@ultimat3/action';
import { registeredTasks } from '@ultimat3/jobs';
import type { Manifest, PolicyFact, RouteFact, TaskFact } from '@ultimat3/manifest';
import {
  buildManifest,
  emitManifest,
  frameworkSources,
  MANIFEST_FILENAME,
  readManifest,
} from '@ultimat3/manifest';
import { knownPermissions } from '@ultimat3/policy';
import { describeQueries } from '@ultimat3/query';
import type { RouteDescriptor } from '@ultimat3/render';
import { describeRoutes } from '@ultimat3/render';
import { loadApp } from './app-load';
import type { Finding } from './output';

export interface AppManifest {
  readonly manifest: Manifest;
  /** Modules that would not load or register. The manifest describes what did.  */
  readonly findings: readonly Finding[];
}

/** Load the app, then describe it. Every command that needs facts goes through here. */
export async function appManifest(root: string): Promise<AppManifest> {
  const loaded = await loadApp(root);
  const manifest = buildManifest(
    frameworkSources({
      app: await appIdentity(root),
      routes: routeFacts(),
      policies: policyFacts(),
      tasks: taskFacts(),
      errorCodes: loaded.errorCodes,
    }),
  );
  return { manifest, findings: loaded.findings };
}

export async function writeAppManifest(root: string, manifest: Manifest): Promise<string> {
  const { path } = await emitManifest({ manifest, path: join(root, MANIFEST_FILENAME) });
  return path;
}

/** The committed contract, or undefined when the app has never generated one. */
export const readAppManifest = async (root: string): Promise<Manifest | undefined> =>
  readManifest(join(root, MANIFEST_FILENAME));

/** Name and version come from `package.json`: the manifest's version gate is a semver gate. */
async function appIdentity(root: string): Promise<{ name: string; version: string }> {
  const file = Bun.file(join(root, 'package.json'));
  if (!(await file.exists())) return { name: 'app', version: '0.0.0' };
  const parsed = (await file.json().catch(() => ({}))) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'app',
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
  };
}

type UrlRoute = RouteDescriptor & { readonly surface: 'site' | 'app' | 'api' };

/** `shared/` is a leaf, never a URL — a descriptor there is a file naming mistake, not a route. */
const hasUrl = (route: RouteDescriptor): route is UrlRoute => route.surface !== 'shared';

const routeFacts = (): readonly RouteFact[] =>
  describeRoutes()
    .filter(hasUrl)
    .map((route) => ({
      url: route.path,
      render: route.mode,
      offline: route.offline,
      hydrate: route.hydrate,
      revalidateTags: route.revalidateTags,
      surface: route.surface,
      ...budgetOf(route),
    }));

function budgetOf(route: RouteDescriptor): { budget?: { js?: string; lcp?: number } } {
  if (route.budgetJs === null && route.budgetLcp === null) return {};
  return {
    budget: {
      ...(route.budgetJs === null ? {} : { js: route.budgetJs }),
      ...(route.budgetLcp === null ? {} : { lcp: route.budgetLcp }),
    },
  };
}

/**
 * One permission, N surfaces — `enforcedIn` is that list, derived from the actions and queries
 * that actually assert it rather than declared a second time next to the policy.
 */
function policyFacts(): readonly PolicyFact[] {
  const enforced = new Map<string, string[]>();
  const add = (permission: string, where: string): void => {
    if (permission.length === 0) return;
    enforced.set(permission, [...(enforced.get(permission) ?? []), where]);
  };
  for (const action of describeActions()) add(action.capability, `action:${action.name}`);
  for (const query of describeQueries()) add(query.capability, `query:${query.name}`);

  return [...new Set([...knownPermissions(), ...enforced.keys()])]
    .sort()
    .map((permission) => ({ permission, enforcedIn: enforced.get(permission) ?? [] }));
}

const taskFacts = (): readonly TaskFact[] =>
  registeredTasks()
    .map((handle) => handle.describe())
    .map((task) => ({ name: task.name, cron: task.cron, tz: task.tz, enqueues: task.jobs }));
