/**
 * The route table — the single source of route truth. File path → URL conventions for
 * `site/` and `app/`, plus `describePages()`, the serializable projection that
 * `x.manifest.json`, the `/_x` routes panel, the sitemap and `sw.js` are all generated
 * from. Nothing downstream may keep its own list of routes.
 */

import type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import { byCodeUnit } from './code-unit-order';
import {
  RouteDuplicateError,
  RouteFileInvalidError,
  RouteUnnormalizedError,
  SurfaceBoundaryError,
} from './errors';
import { assertModeInvariants, defaultIslandBudget } from './modes';
import type { MountedRouteInput, RouteMount, RouteMountInput } from './mounted-routes';
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
import type { CompiledPattern } from './route-pattern';
import { compilePattern } from './route-pattern';
import type { RouteSurface, Surface } from './surfaces';
import { locateSurface } from './surfaces';

/**
 * The one filename a route may carry, per route surface. Keyed by `RouteSurface`, so both rows are
 * MANDATORY: a dropped row would read as `undefined` in `assertRouteFilename`.
 */
export const ROUTE_FILENAME = Object.freeze<Record<RouteSurface, string>>({
  site: 'page.tsx',
  app: 'page.tsx',
});

/** Stems that already meant "this directory", so the repair is a rename in place, not a new folder. */
const DIRECTORY_STEMS = new Set(['index', 'page', 'route']);

export interface RouteEntry<TData = RouteData> {
  readonly file: string;
  readonly path: string;
  readonly surface: RouteSurface;
  readonly config: RouteConfig<TData>;
  readonly suspenseBoundaries: number;
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
   * `null` when the route declared none — its pages then key on the WHOLE query string.
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

/**
 * `apps/web/site/blog/[slug]/page.tsx` → `{ surface: 'site', path: '/blog/:slug' }`.
 *
 * The URL is the **directory** path under the surface; the filename names the kind of file, never
 * a URL segment. Anything else is `X_ROUTE_FILE_INVALID` — one spelling per surface, so an agent
 * reading a folder knows which file is the route without opening any of them.
 *
 * | file | path |
 * |---|---|
 * | `site/page.tsx` | `/` |
 * | `site/pricing/page.tsx` | `/pricing` |
 * | `site/(marketing)/about/page.tsx` | `/about` |
 * | `site/blog/[slug]/page.tsx` | `/blog/:slug` |
 * | `site/docs/[...path]/page.tsx` | `/docs/*path` |
 * | `app/dashboard/page.tsx` | `/dashboard` |
 */
export function routePathFromFile(file: string): { surface: RouteSurface; path: string } {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  // One reader of the surface segment, and it answers WHERE as well as WHICH. Slicing at
  // `indexOf('app/')` instead matched inside `myapp/`, so `apps/myapp/app/page.tsx` resolved to
  // `/app` rather than `/` — the surface came from an anchored regex and the URL from a substring.
  const located = locateSurface(normalized);
  if (located === null) {
    throw new SurfaceBoundaryError(
      `${file} is not inside a surface directory, so it has no URL and no bundle graph`,
      `move ${file} under site/ or app/, named page.tsx`,
    );
  }
  const surface = routeSurfaceOf(normalized, located.surface);

  const rawSegments = located.rest.split('/').filter((s) => s.length > 0);
  assertRouteFilename(normalized, surface, rawSegments[rawSegments.length - 1]);

  const urlSegments = rawSegments
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map(toUrlSegment);

  const path = `/${urlSegments.join('/')}`.replace(/\/+$/, '') || '/';
  return { surface, path };
}

/**
 * POSIX single-quotes a filesystem-derived operand for a `fix:` command: close the quote, escape
 * an embedded quote as `'\''`, reopen it. A `fix:` is copied and run verbatim (axiom 4), so a route
 * filename carrying a space, an apostrophe or a shell metacharacter must not change what runs.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Only `site/` and `app/` hold route files. `shared/` is a leaf of helpers with no URL; `api/` is
 * the action and query projections `defineApi()` collects — a wire format an action cannot speak
 * is a plain HTTP route in the `routes` runtime override, never a file under `api/`.
 */
function routeSurfaceOf(file: string, surface: Surface): RouteSurface {
  if (surface === 'shared') {
    throw new RouteFileInvalidError(
      `${file} is under shared/, which is a leaf of helpers with no URL — a route cannot live there`,
      `move ${file} under site/ or app/, named page.tsx`,
    );
  }
  if (surface === 'api') {
    throw new RouteFileInvalidError(
      `${file} is under api/, which holds no route file: api/ is the actions and queries defineApi() collects`,
      `JSON in and out: replace ${file} with an action (x g action <name>) collected by defineApi() in api/index.ts. Another wire format (a webhook, an OAuth endpoint): delete ${file} and add a plain HTTP route to the routes array exported as runtime from apps/<app>/runtime.ts`,
    );
  }
  return surface;
}

/**
 * Enforced rather than documented (axiom 3): a convention that is not a build error is not a
 * convention. The fix is the move that makes the file a route, spelled out — the directory the
 * author already meant, plus the one filename that surface accepts.
 */
function assertRouteFilename(
  file: string,
  surface: RouteSurface,
  basename: string | undefined,
): void {
  const expected = ROUTE_FILENAME[surface];
  if (basename === expected) return;

  // The directory the author meant is the file's own path minus its extension: `site/pricing.tsx`
  // was always trying to be `/pricing`, so `site/pricing/page.tsx` is the move, not a guess.
  // `index`, `page` and `route` are the exception — each already means "this directory", so the
  // rename happens in place and no directory is created.
  const stem = file.replace(/\.(tsx|ts|jsx|js)$/, '');
  const dir = stem.slice(0, stem.lastIndexOf('/'));
  const inPlace = DIRECTORY_STEMS.has(stem.slice(dir.length + 1));
  const target = inPlace ? `${dir}/${expected}` : `${stem}/${expected}`;
  // Plain `mv`, never `git mv`. `x new --no-git` scaffolds a tree with no repository, and there the
  // shipped `git mv` answered `fatal: not a git repository` — a fix line that fails is worse than
  // no fix line, because the reader debugs git instead of moving the file. `mv` works in both
  // cases: git detects the rename at `git add` time, so the only thing given up is a nicety, and
  // the instruction is the same one either way. `-n` keeps the one guarantee `git mv` did carry:
  // an author who adds the correct `site/pricing/page.tsx` and leaves `site/pricing.tsx` behind is
  // reported against the stale file, and `target` is then the GOOD file — a clobber deletes a
  // working route, and this fix line is pasted unread.
  throw new RouteFileInvalidError(
    `${file} is a route on the ${surface} surface, so it must be named ${expected}: the URL is the ` +
      'directory path and the filename names the kind of file',
    inPlace
      ? `mv -n -- ${shellQuote(file)} ${shellQuote(target)}`
      : `mkdir -p -- ${shellQuote(stem)} && mv -n -- ${shellQuote(file)} ${shellQuote(target)}`,
  );
}

function toUrlSegment(segment: string): string {
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll?.[1] !== undefined) return `*${catchAll[1]}`;
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic?.[1] !== undefined) return `:${dynamic[1]}`;
  return segment;
}

const routes = new Map<string, RouteEntry>();
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
  /** Counted from the module's JSX by the build; `stream` requires >= 1. */
  readonly suspenseBoundaries?: number;
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
      `wrap the declaration in ${input.file}: registerRoute({ file, config: defineRoute({ … }) })`,
    );
  }

  const derived = routePathFromFile(input.file);
  const path = input.path ?? derived.path;
  // `ctx.suspenseBoundaries < 1` is the only thing between `render: 'stream'` and a route that
  // streams nothing, and `NaN < 1` is false — a count that arrived non-finite does not report the
  // route it counted, it stops reporting any route.
  const suspenseBoundaries = finiteCount(
    'registerRoute',
    'suspenseBoundaries',
    input.suspenseBoundaries ?? 0,
  );
  // Explicit `<TData>`: `isRouteConfig` is a guard over the default `RouteData`, so inference off
  // the narrowed argument would resolve the route's own data generic away here.
  const config = withIslandBudget<TData>(input.config, derived.surface);

  assertModeInvariants(config, {
    file: input.file,
    path,
    surface: derived.surface,
    suspenseBoundaries,
  });

  assertPurgeableTags(input.file, config.revalidate?.tags);

  const existing = routes.get(path);
  if (existing !== undefined && existing.file !== input.file) {
    throw new RouteDuplicateError(
      `${path} is claimed by both ${existing.file} and ${input.file}`,
      `rename or delete one of them — the route table is keyed by URL`,
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
    suspenseBoundaries,
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
  declaredConfigs.clear();
  clearMountedRoutes();
  described = undefined;
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

/**
 * `undefined` for a malformed percent-escape. A pathname is whatever the client typed, and
 * `decodeURIComponent('%zz')` throws a bare `URIError` — no code, no fix line — where a router
 * already has an answer for "this branch does not match".
 *
 * Still exported after this package's own `matchRoute` was deleted for `@ultimat3/http`'s trie
 * (`stages.ts`): it is the one answer to "is this segment decodable?" on this side of the wire,
 * and a second copy of it is how one of the two ends up throwing where the other 404s.
 */
export function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
