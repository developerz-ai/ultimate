/**
 * The route table — the single source of route truth. File path → URL conventions for
 * `site/` and `app/`, plus `describePages()`, the serializable projection that
 * `x.manifest.json`, the `/_x` routes panel, the sitemap and `sw.js` are all generated
 * from. Nothing downstream may keep its own list of routes.
 */

import type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
import { byCodeUnit } from './code-unit-order';
import { RouteDuplicateError, RouteUnnormalizedError } from './errors';
import { assertModeInvariants, defaultIslandBudget } from './modes';
import type {
  MountedRoute,
  MountedRouteInput,
  RouteMount,
  RouteMountInput,
} from './mounted-routes';
import {
  claimedBy,
  clearMountedRoutes,
  mountCollision,
  mountedAt,
  mountedRoutes,
  setMountedRoutes,
} from './mounted-routes';
import { assertPurgeableTags } from './revalidate-shape';
import type { InvalidateMode, RouteConfig, RouteData } from './route';
import { isRouteConfig, routeTagKeys } from './route';
import type { RouteComponent } from './route-component';
import { routePathFromFile } from './route-path';
import type { CompiledPattern } from './route-pattern';
import { compilePattern } from './route-pattern';
import type { RouteSurface, Surface } from './surfaces';

export { decodeSegment } from './decode-segment'; // split out at the line ceiling
export { ROUTE_FILENAME, routePathFromFile } from './route-path'; // split out at the line ceiling

export interface RouteEntry<TData = RouteData> {
  readonly file: string;
  readonly path: string;
  readonly surface: RouteSurface;
  readonly config: RouteConfig<TData>;
  readonly islands: readonly string[];
  readonly pattern: CompiledPattern;
  /**
   * The module's page component. Absent for a module that exports none.
   */
  readonly component?: RouteComponent;
}

export interface RouteDescriptor {
  readonly path: string;
  readonly file: string;
  readonly surface: Surface;
  readonly mode: RenderMode;
  readonly offline: OfflineStrategy;
  readonly hydrate: HydrateStrategy;
  readonly revalidateTags: readonly string[];
  readonly revalidateTtl: string | number | null;
  /**
   * The three below are optional so a descriptor built by hand before they existed still
   * typechecks; the registry always writes them. Absent reads as `'stale'`, unbounded, undeclared.
   */
  readonly revalidateOnInvalidate?: InvalidateMode;
  readonly revalidateMaxStale?: string | number | null;
  /**
   * `revalidate.query`, sorted: the only query parameters an `isr` page of this route keys on.
   * `null` when the route declared none — its pages then key on no query at all.
   */
  readonly revalidateQuery?: readonly string[] | null;
  readonly prerenderable: boolean;
  readonly dynamic: boolean;
  readonly hasPolicy: boolean;
  /**
   * The document is rendered FOR someone: a `policy`, a `stream` (always `private, no-store`), or a
   * declared `cache` of `no-store` / `private`. `sw.js` never caches one (`@ultimat3/pwa`'s
   * `strategyFor`): a per-member page kept for offline answered the previous member's data on a
   * shared device after sign-out.
   */
  readonly personal: boolean;
  readonly islands: readonly string[];
  /**
   * Each island's `src`, relative to `file`, in `islands` order — what the island bundle resolves
   * to a chunk URL, so `sw.js` precaches only the chunks a precached page boots.
   */
  readonly islandSources: readonly string[];
  readonly budgetJs: string | null;
  /**
   * Present on a route a package mounted: who mounted it and every permission that gates it.
   * `file` is the package — unless `mount.claimed`, when an app file serves the path in the
   * mount's place and `file` is that file. Absent on every other file route.
   */
  readonly mount?: RouteMount;
}

export type { MountedRouteInput, RouteMount, RouteMountInput } from './mounted-routes';

const routes = new Map<string, RouteEntry>();
/** route file → its URL pattern: what `render.page` reports a component's render under. */
const patternsByFile = new Map<string, string>();
/**
 * The config each path's module EXPORTED, before `withIslandBudget` may have copied it: a mount's
 * `claimable` answers by identity, and the entry's own config is not always that object.
 */
const declaredConfigs = new Map<string, RouteConfig>();
/** The table `describePages()` last built, dropped whenever a route registers or the registry clears. */
let described: readonly RouteDescriptor[] | undefined;

export interface RegisterRouteInput<TData = RouteData> {
  readonly file: string;
  readonly config: RouteConfig<TData>;
  // No `islands` key: an island is declared by `island()` and reaches the entry through
  // `config.islands`. It was here, undocumented, passed by nothing, and read as
  // `input.islands ?? []` — so the only thing a caller could do with it was un-weigh a
  // declaration. One question, one answer.
  /** Override the convention (locale roots, rewrites). Rarely needed. */
  readonly path?: string;
  /** The page component, resolved from the module by `pageComponentOf`. */
  readonly component?: RouteComponent;
}

/** Register a route and enforce every invariant that needs the surrounding module. */
export function registerRoute<TData = RouteData>(
  input: RegisterRouteInput<TData>,
): RouteEntry<TData> {
  // The type already refuses a declaration; this catches the JS caller and the cast. Without it a
  // raw declaration registers, and `describePages()` is where it surfaces — as a bare TypeError
  // on `config.budget.js`, one build step away from the file that caused it.
  if (!isRouteConfig(input.config)) {
    throw new RouteUnnormalizedError(
      `${input.file} registered a route declaration, not a descriptor: defineRoute normalizes ` +
        '`meta` and `budget`, and the route table has no other normalizer',
      `registerRoute({ file, config: defineRoute({ … }) })   // wrap the declaration in ${input.file}`,
    );
  }

  const derived = routePathFromFile(input.file);
  const path = input.path ?? derived.path;
  // Explicit `<TData>`: `isRouteConfig` is a guard over the default `RouteData`, so inference off
  // the narrowed argument would resolve the route's own data generic away here.
  const config = withIslandBudget<TData>(input.config, derived.surface);

  assertModeInvariants(config, {
    file: input.file,
    path,
    surface: derived.surface,
  });

  assertPurgeableTags(input.file, config.revalidate?.tags);

  const existing = routes.get(path);
  if (existing !== undefined && existing.file !== input.file) {
    throw new RouteDuplicateError(
      `${path} is claimed by both ${existing.file} and ${input.file}`,
      `x routes --json   # rename or delete one of the two files at ${path} — the route table is keyed by URL`,
    );
  }
  const claimed = mountedAt(path);
  if (claimed !== undefined && !claimedBy(claimed, input.config as RouteConfig)) {
    throw mountCollision(path, input.file, claimed.mount);
  }

  const entry: RouteEntry<TData> = {
    file: input.file,
    path,
    surface: derived.surface,
    config,
    // The declaration is the ONLY source. It was `input.islands ?? []`, which nothing ever passed,
    // so the now-deleted `routeJsBytes`'s "what registration declared" half read `[]` on every
    // route in the framework's history — and keeping the input as a fallback would be a second
    // answer to one question that can only ever weaken it: a caller passing `[]` un-declares an
    // island. The field outlives that reader: it is the only record a build has of an island a
    // page declared but did not render on a given pass.
    islands: config.islands.map((spec) => spec.moduleId),
    pattern: compilePattern(path),
    // Spread, never assigned: `exactOptionalPropertyTypes` makes an explicit `undefined` a
    // different answer from an absent key, and every reader tests presence.
    ...(input.component === undefined ? {} : { component: input.component }),
  };
  routes.set(path, entry as RouteEntry);
  patternsByFile.set(input.file, path);
  declaredConfigs.set(path, input.config as RouteConfig);
  described = undefined;
  return entry;
}

/**
 * The half of the derivation `defineRoute` cannot make: a budget is only meaningful against a
 * surface baseline, and the surface is a fact of the file path, which the route table is already
 * the one reader of. `defineRoute` stays the normalizer of everything the declaration alone
 * decides; this fills in the one value that needs the URL.
 *
 * Returns the descriptor untouched unless there is something to derive, so identity is preserved
 * for every route that declared a budget or has no island.
 */
function withIslandBudget<TData>(config: RouteConfig<TData>, surface: Surface): RouteConfig<TData> {
  // `'never'` is left bare on purpose: a route that ships no JavaScript has nothing to budget, and
  // a derived ceiling there would paper over the one contradiction `X_ISLAND_NOT_HYDRATED` names.
  if (config.hydrate === 'never') return config;
  if (config.islands.length === 0 || config.budget.js !== undefined) return config;
  const derived: RouteConfig<TData> = {
    ...config,
    budget: { ...config.budget, js: defaultIslandBudget(surface) },
  };
  return Object.freeze(derived);
}

/**
 * Declare the routes a package MOUNTS — screens no surface file exists for, like the admin's — so
 * the one route list carries them. Described, never rendered here: the mounting host serves them,
 * and `routeEntries()` stays the pages a file declares. Re-declaring a `key` replaces its set,
 * because `x dev` re-evaluates the module that declared it on every save.
 */
export function registerMountedRoutes(
  mount: RouteMountInput,
  declared: readonly MountedRouteInput[],
): void {
  for (const route of declared) {
    const file = routes.get(route.path)?.file;
    const config = declaredConfigs.get(route.path);
    const claimed = config !== undefined && claimedBy({ ...route, mount }, config);
    if (file !== undefined && !claimed) throw mountCollision(route.path, file, mount);
    assertPurgeableTags(mount.file, route.config.revalidate?.tags);
  }
  setMountedRoutes(mount, declared);
  described = undefined;
}

export function clearRoutes(): void {
  routes.clear();
  patternsByFile.clear();
  declaredConfigs.clear();
  clearMountedRoutes();
  described = undefined;
}

/** The whole table: what `restoreRoutes` puts back. Test seam (`@ultimat3/testing`'s boundary). */
export interface RouteSnapshot {
  readonly routes: readonly (readonly [string, RouteEntry, RouteConfig | undefined])[];
  readonly patterns: readonly (readonly [string, string])[];
  readonly mounted: readonly MountedRoute[];
}

export const routeSnapshot = (): RouteSnapshot => ({
  routes: [...routes].map(([path, entry]) => [path, entry, declaredConfigs.get(path)] as const),
  patterns: [...patternsByFile],
  mounted: mountedRoutes(),
});

/** Exactly `snapshot` again — a REPLACE: a module-scope route never registers twice. */
export function restoreRoutes(snapshot: RouteSnapshot): void {
  clearRoutes();
  for (const [path, entry, config] of snapshot.routes) {
    routes.set(path, entry);
    if (config !== undefined) declaredConfigs.set(path, config);
  }
  for (const [file, path] of snapshot.patterns) patternsByFile.set(file, path);
  const byMount = new Map<RouteMountInput, MountedRoute[]>();
  for (const route of snapshot.mounted)
    byMount.set(route.mount, [...(byMount.get(route.mount) ?? []), route]);
  for (const [mount, set] of byMount) setMountedRoutes(mount, set);
}

export function routeCount(): number {
  return routes.size;
}

export function routeEntries(): readonly RouteEntry[] {
  // Code units, never `localeCompare` — `describePages()` below promises an order "identical for
  // identical input", and `localeCompare` with no locale argument reads the runtime's ICU default.
  return [...routes.values()].sort((a, b) => byCodeUnit(a.path, b.path));
}

export function routeFor(path: string): RouteEntry | undefined {
  return routes.get(path);
}

/** The URL pattern a registered route FILE serves (`/blog/:slug`), or `undefined` for none. */
export function routePatternOfFile(file: string): string | undefined {
  return patternsByFile.get(file);
}

/**
 * The manifest projection: JSON-safe, sorted by path, identical for identical input.
 * Determinism matters because `sw.js` and the sitemap are diffed across deploys.
 */
export function describePages(): readonly RouteDescriptor[] {
  // Built once per registry change and handed out as the SAME frozen array: an ISR regeneration
  // looked its route up through this on every request, re-sorting the whole table each time, and
  // a stable identity is what lets `render-isr.ts` compile its matchers once per table.
  described ??= Object.freeze(buildDescriptors());
  return described;
}

function buildDescriptors(): RouteDescriptor[] {
  const mounted = mountedRoutes();
  // A path an app file claimed is ONE row: the file's, still naming the mount that gates it.
  const claimOf = (path: string): RouteMount | undefined => {
    const route = mounted.find((candidate) => candidate.path === path);
    return route === undefined
      ? undefined
      : { by: route.mount.by, permissions: [...route.permissions], claimed: true };
  };
  const files = routeEntries().map((entry): RouteDescriptor => {
    const row = descriptorOf(
      entry.path,
      entry.file,
      entry.surface,
      entry.config,
      entry.pattern.keys.length,
    );
    const claim = claimOf(entry.path);
    return claim === undefined ? row : { ...row, mount: claim };
  });
  const mounts = mounted
    .filter((route) => !routes.has(route.path))
    .map(
      (route): RouteDescriptor => ({
        ...descriptorOf(
          route.path,
          route.mount.file,
          route.mount.surface,
          route.config,
          compilePattern(route.path).keys.length,
        ),
        mount: { by: route.mount.by, permissions: [...route.permissions] },
      }),
    );
  return mounts.length === 0
    ? files
    : [...files, ...mounts].sort((a, b) => byCodeUnit(a.path, b.path));
}

const descriptorOf = (
  path: string,
  file: string,
  surface: Surface,
  config: RouteConfig,
  params: number,
): RouteDescriptor => ({
  path,
  file,
  surface,
  mode: config.render,
  offline: config.offline,
  hydrate: config.hydrate,
  revalidateTags: routeTagKeys(config.revalidate?.tags),
  revalidateTtl: config.revalidate?.ttl ?? null,
  revalidateOnInvalidate: config.revalidate?.onInvalidate ?? 'stale',
  revalidateMaxStale: config.revalidate?.maxStale ?? null,
  revalidateQuery:
    config.revalidate?.query === undefined ? null : [...new Set(config.revalidate.query)].sort(),
  prerenderable: config.prerender !== undefined,
  dynamic: params > 0,
  hasPolicy: config.policy !== undefined,
  personal: isPersonal(config),
  islands: config.islands.map((spec) => spec.moduleId),
  islandSources: config.islands.map((spec) => spec.src),
  budgetJs: config.budget.js ?? null,
});

/** See `RouteDescriptor.personal`. */
function isPersonal(config: RouteConfig): boolean {
  if (config.policy !== undefined || config.render === 'stream') return true;
  const cache = config.cache;
  if (cache === undefined) return false;
  return cache === 'no-store' || cache.mode === 'no-store' || cache.mode === 'private';
}
