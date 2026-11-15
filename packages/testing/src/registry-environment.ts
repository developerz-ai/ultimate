// The permissions and roles a test file inherits on a shared worker: what a module in ITS import
// graph declared, never what a module only an earlier file imported left behind. Read from each
// name's declaration site; `registry-leak-guard.ts` owns WHEN, `import-graph.ts` the graph.

import type { RoleMap } from '@ultimat3/policy';
import type { ImportGraph } from './import-graph';
import type { ProcessRegistrySnapshot } from './registry-snapshot';

/** The policy half of a snapshot — the only half this narrows. */
export type PolicyEnvironment = Pick<
  ProcessRegistrySnapshot,
  'permissions' | 'permissionSites' | 'roles' | 'roleSites'
>;

/** Names kept whatever the graph says: the preload's, and those first declared during THIS load. */
export interface KeptNames {
  readonly permissions: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
}

/** `?x-reload=…` is a loader's cache key, not part of the file. */
const withoutQuery = (path: string): string => path.replace(/\?.*$/, '');

/**
 * The file a stack frame names — `at /a/b.ts:5:1`, `at fn (/a/b.ts:5:1)`, `at async C:\a\b.ts:5:1`
 * — `/`-normalised, or `undefined` for a frame that names none (`unknown site`, `<anonymous>`).
 */
export function siteFile(frame: string): string | undefined {
  const line = frame.trim();
  const file = (/\(([^()]+):\d+:\d+\)$/.exec(line) ??
    /^at (?:async )?(.+):\d+:\d+$/.exec(line))?.[1];
  if (file === undefined || file.startsWith('<') || file.startsWith('native')) return undefined;
  return withoutQuery(file.replaceAll('\\', '/'));
}

/**
 * In the graph when ANY site is, and when a site cannot be read at all: an unreadable site is
 * provenance this cannot judge, and dropping a name a cached module really declared is the one
 * failure a file cannot repair from inside.
 */
const reachable = (sites: readonly string[], modules: ReadonlySet<string>): boolean =>
  sites.length === 0 ||
  sites.some((site) => {
    const file = siteFile(site);
    return file === undefined || modules.has(file);
  });

/**
 * `inherited` narrowed to the names `graph` reaches, plus `kept`. An incomplete graph narrows
 * nothing: a module it could not read may be the one that declared.
 */
export function ownEnvironment(
  inherited: PolicyEnvironment,
  graph: ImportGraph,
  kept: KeptNames,
): PolicyEnvironment {
  if (!graph.complete) return inherited;
  const modules = new Set([...graph.modules].map((path) => path.replaceAll('\\', '/')));
  const permissions = inherited.permissions.filter(
    (name) =>
      kept.permissions.has(name) ||
      reachable(
        Object.hasOwn(inherited.permissionSites, name)
          ? (inherited.permissionSites[name] ?? [])
          : [],
        modules,
      ),
  );
  const roles: Record<string, RoleMap[string]> = {};
  const roleSites: Record<string, string> = {};
  for (const [name, definition] of Object.entries(inherited.roles)) {
    const site = Object.hasOwn(inherited.roleSites, name) ? inherited.roleSites[name] : undefined;
    if (!kept.roles.has(name) && !reachable(site === undefined ? [] : [site], modules)) continue;
    roles[name] = definition;
    if (site !== undefined) roleSites[name] = site;
  }
  const permitted = new Set(permissions);
  const permissionSites = Object.fromEntries(
    Object.entries(inherited.permissionSites).filter(([name]) => permitted.has(name)),
  );
  return { permissions, permissionSites, roles, roleSites };
}
