// Registering one imported app module, once per process: its route, its actions, its queries, and
// — for a process that rescans — its pin in the reload graph. The scan (`app-load.ts`) and the
// prebuilt registry's boot (`app-load-prebuilt.ts`) both register through here, so a module
// registers the same way whichever of them imported it.

import { isAction, isMutator, registerActions } from '@ultimat3/action';
import { getEntity } from '@ultimat3/entity';
import { isJobHandle, isTaskHandle } from '@ultimat3/jobs';
import { isQuery, registerQueries } from '@ultimat3/query';
import type { RouteConfig } from '@ultimat3/render';
import { isRouteConfig, pageComponentOf, registerRoute } from '@ultimat3/render';
import { pinModule, resetReloadGraph } from './app-reload-graph';
import { API_INDEX } from './app-root';
import type { Finding } from './output';
import { findingFrom } from './output';

// A module is imported and registered once per PROCESS: `import()` caches, and a registry rejects
// a second registration of a name. So a rescan refreshes the facts DERIVED from the registries —
// the manifest and its build id — and, for exactly one kind of module, the registration itself. A
// rescan first evicts every changed module, and everything that imports it, from Bun's registry
// (`app-reload-graph.ts`), so the scan's own `import()` evaluates the new chain; a ROUTE module
// that comes back as a different instance has its entry replaced. A module that defines a
// primitive (an action, a query, an entity, a job, a task) is pinned instead — its exports are held
// by every importer and a second instance would be a duplicate name in its registry — so those
// edits still need a restart. Until 2026-09-27 only the route module itself was re-imported, under
// `?x-reload=<hash>`, and every component it imports stayed the cached one: `x dev` logged
// "reloaded" and served the old component.
const registered = new Set<string>();
// A registration failure is sticky: the file is never retried, so the finding is replayed.
const failures = new Map<string, Finding>();
// Route modules only: the module instance each one registered from. A rescan that imports the same
// instance registers nothing; a different one (the file or something it imports was evicted) is
// the page the author saved.
const routeModules = new Map<string, Record<string, unknown>>();

/** Test seam, and what `x dev` would call if it ever restarted the registries in-process. */
export function resetAppLoad(): void {
  registered.clear();
  failures.clear();
  routeModules.clear();
  resetReloadGraph();
}

/** Whether any module has registered in this process: a scan after one is a rescan. */
export const registeredAny = (): boolean => registered.size > 0;

/** Whether `absolute` has never been through `registerModule` — registered or failed. */
export const isFirstPass = (absolute: string): boolean =>
  !registered.has(absolute) && !failures.has(absolute);

/**
 * Whether `value` is an entity the registry holds — the entry, or the `core` an `entity()` module
 * exports. Asked of the registry by the value's own name, so it is O(1) and never stale: a scan
 * registers module by module while later modules are still evaluating and registering entities,
 * and a set built once (as until 2026-11-09) missed every entity declared after it.
 */
export function isRegisteredEntity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const named: unknown = Reflect.get(value, '$name') ?? Reflect.get(value, 'name');
  if (typeof named !== 'string') return false;
  const entry = getEntity(named);
  return entry !== undefined && (entry === value || entry.core === value);
}

/** One module's registration: what `registerModule` needs beyond the module itself. */
export interface ModuleRegistration {
  readonly absolute: string;
  /** App-root-relative, POSIX. */
  readonly file: string;
  /** A process that rescans: pins primitive-defining modules, re-registers changed routes. */
  readonly track: boolean;
}

/**
 * Registers a module once; every later call replays whatever the first one reported — except for
 * a route module, which a later call re-registers when the import handed back a new instance.
 */
export function registerModule(
  module: Record<string, unknown>,
  at: ModuleRegistration,
): Finding | undefined {
  const { absolute, file, track } = at;
  const previous = failures.get(absolute);
  if (previous !== undefined) return previous;
  if (registered.has(absolute)) return track ? reloadRoute(absolute, file, module) : undefined;
  registered.add(absolute);
  try {
    const config = module['config'];
    const route = isRouteConfig(config) ? config : undefined;
    if (route !== undefined) {
      registerRouteModule(file, module, route);
      routeModules.set(absolute, module);
    }
    // A pin is the reload graph's: it stops an eviction a process that never rescans never runs,
    // and deciding it walks every export of every module against the entity registry.
    if (track && (definesPrimitive(module, route !== undefined) || file === API_INDEX)) {
      pinModule(absolute);
    }
    registerActions(module);
    registerQueries(module);
    return undefined;
  } catch (error) {
    const finding: Finding = { ...findingFrom(error), at: file };
    failures.set(absolute, finding);
    return finding;
  }
}

/**
 * A module whose instance must be the one every importer and every registry holds. A route module
 * may export an action beside its page — it has always been re-imported, and its actions stayed
 * registered from the first instance — so only an entity, a job or a task pins a route.
 */
function definesPrimitive(module: Record<string, unknown>, route: boolean): boolean {
  const defines = (value: unknown): boolean =>
    isJobHandle(value) ||
    isTaskHandle(value) ||
    (!route && (isAction(value) || isQuery(value) || isMutator(value))) ||
    isRegisteredEntity(value);
  return Object.values(module).some((value) => {
    // A brand check reads a property, and an export may be a proxy whose every read throws until
    // the env is set — examples/dummy's typed client throws X_ENV_MISSING without APP_URL. A value
    // that cannot be asked is not a primitive: every primitive is a plain branded object.
    try {
      return defines(value);
    } catch {
      return false;
    }
  });
}

/** The route half of a registration, and the whole of a re-registration. */
function registerRouteModule(
  file: string,
  module: Record<string, unknown>,
  config: RouteConfig,
): void {
  // The page component comes from the same module as its config, resolved by render's own
  // rule — the CLI does not decide which export is a page any more than it decides what a
  // route is. A module with no component registers without one, and renders a bare shell.
  const component = pageComponentOf(module);
  registerRoute({
    file,
    config,
    ...(component === undefined ? {} : { component }),
  });
}

/**
 * A registered route module, on a rescan: re-registered when the import handed back a different
 * instance — the file or something it imports was evicted — and left alone otherwise. A save that
 * will not import never reaches here (the scan reports it, not sticky), so the last page that did
 * import is the one served meanwhile.
 */
function reloadRoute(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
): Finding | undefined {
  const held = routeModules.get(absolute);
  if (held === undefined || held === module) return undefined;
  try {
    const config = module['config'];
    // A file that stopped being a route is not un-registered — the table has no verb for it, and a
    // deleted file needs a restart either way. Its instance is recorded so the same save is not
    // re-registered on every later tick.
    if (isRouteConfig(config)) registerRouteModule(file, module, config);
    routeModules.set(absolute, module);
    return undefined;
  } catch (error) {
    return { ...findingFrom(error), at: file };
  }
}
