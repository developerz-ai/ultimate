/**
 * The route table — the single source of route truth. File path → URL conventions for
 * `site/`, `app/` and `api/`, plus `describeRoutes()`, the serializable projection that
 * `x.manifest.json`, the `/_x` routes panel, the sitemap and `sw.js` are all generated
 * from. Nothing downstream may keep its own list of routes.
 */

import type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
import {
  RouteDuplicateError,
  RouteFileInvalidError,
  RouteUnnormalizedError,
  SurfaceBoundaryError,
} from './errors';
import { assertModeInvariants, defaultIslandBudget } from './modes';
import type { RouteConfig, RouteData, RouteParams } from './route';
import { isRouteConfig, tagKeys } from './route';
import type { RouteComponent } from './route-component';
import type { Surface } from './surfaces';
import { locateSurface } from './surfaces';

/**
 * The one filename a route may carry, per surface. `shared/` is `Exclude`d rather than merely
 * absent: it is a leaf of helpers with no URL, so a route file there has nowhere to resolve to —
 * and stating that in the key type makes the other three MANDATORY. `Partial<Record<Surface, …>>`
 * said the same thing about `shared` and let any of the three go missing, which only three
 * registration tests would have caught. A dropped `api` row is not a crash: `assertRouteFilename`
 * reads `undefined` as "this file is under shared/", so every `api/` route author would have been
 * told their file is a leaf of helpers.
 */
export const ROUTE_FILENAME = Object.freeze<Record<Exclude<Surface, 'shared'>, string>>({
  site: 'page.tsx',
  app: 'page.tsx',
  api: 'route.ts',
});

/** Stems that already meant "this directory", so the repair is a rename in place, not a new folder. */
const DIRECTORY_STEMS = new Set(['index', 'page', 'route']);

const API_PREFIX = '/api';

export interface RouteEntry<TData = RouteData> {
  readonly file: string;
  readonly path: string;
  readonly surface: Surface;
  readonly config: RouteConfig<TData>;
  readonly suspenseBoundaries: number;
  readonly islands: readonly string[];
  readonly pattern: CompiledPattern;
  /**
   * The module's page component. Absent for `api/` routes and for a module that exports none —
   * a `spa` shell is the mode that legitimately has no server-rendered body.
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
  readonly prerenderable: boolean;
  readonly dynamic: boolean;
  readonly hasPolicy: boolean;
  readonly islands: readonly string[];
  readonly budgetJs: string | null;
  readonly budgetLcp: number | null;
}

export interface CompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
  readonly keys: readonly string[];
  /** Higher wins when two patterns match the same pathname. */
  readonly specificity: number;
}

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
 * | `api/posts/route.ts` | `/api/posts` |
 */
export function routePathFromFile(file: string): { surface: Surface; path: string } {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  // One reader of the surface segment, and it answers WHERE as well as WHICH. Slicing at
  // `indexOf('app/')` instead matched inside `myapp/`, so `apps/myapp/app/page.tsx` resolved to
  // `/app` rather than `/` — the surface came from an anchored regex and the URL from a substring.
  const located = locateSurface(normalized);
  if (located === null) {
    throw new SurfaceBoundaryError(
      `${file} is not inside a surface directory, so it has no URL and no bundle graph`,
      `move ${file} under site/, app/ or api/`,
    );
  }
  const surface = located.surface;

  const rawSegments = located.rest.split('/').filter((s) => s.length > 0);
  assertRouteFilename(normalized, surface, rawSegments[rawSegments.length - 1]);

  const urlSegments = rawSegments
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map(toUrlSegment);

  const base = surface === 'api' ? API_PREFIX : '';
  const path = `${base}/${urlSegments.join('/')}`.replace(/\/+$/, '') || '/';
  return { surface, path };
}

/**
 * POSIX single-quotes a filesystem-derived operand for a `fix:` command: close the quote, escape
 * an embedded quote as `'\''`, reopen it. A `fix:` is copied and run verbatim (axiom 4), so a route
 * filename carrying a space, an apostrophe or a shell metacharacter must not change what runs.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Enforced rather than documented (axiom 3): a convention that is not a build error is not a
 * convention. The fix is the move that makes the file a route, spelled out — the directory the
 * author already meant, plus the one filename that surface accepts.
 */
function assertRouteFilename(file: string, surface: Surface, basename: string | undefined): void {
  // `shared` is the one surface with no filename, and the key type now says so — which is why
  // this is a comparison rather than an `undefined` check on the lookup.
  const expected = surface === 'shared' ? undefined : ROUTE_FILENAME[surface];
  if (expected === undefined) {
    throw new RouteFileInvalidError(
      `${file} is under shared/, which is a leaf of helpers with no URL — a route cannot live there`,
      `move ${file} under site/, app/ or api/, named page.tsx (site/, app/) or route.ts (api/)`,
    );
  }
  if (basename === expected) return;

  // The directory the author meant is the file's own path minus its extension: `site/pricing.tsx`
  // was always trying to be `/pricing`, so `site/pricing/page.tsx` is the move, not a guess.
  // `index`, `page` and `route` are the exception — each already means "this directory", so the
  // rename happens in place and no directory is created.
  const stem = file.replace(/\.(tsx|ts|jsx|js)$/, '');
  const dir = stem.slice(0, stem.lastIndexOf('/'));
  const inPlace = DIRECTORY_STEMS.has(stem.slice(dir.length + 1));
  const target = inPlace ? `${dir}/${expected}` : `${stem}/${expected}`;
  throw new RouteFileInvalidError(
    `${file} is a route on the ${surface} surface, so it must be named ${expected}: the URL is the ` +
      'directory path and the filename names the kind of file',
    inPlace
      ? `git mv -- ${shellQuote(file)} ${shellQuote(target)}`
      : `mkdir -p -- ${shellQuote(stem)} && git mv -- ${shellQuote(file)} ${shellQuote(target)}`,
  );
}

function toUrlSegment(segment: string): string {
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll?.[1] !== undefined) return `*${catchAll[1]}`;
  const dynamic = /^\[(.+)\]$/.exec(segment);
  if (dynamic?.[1] !== undefined) return `:${dynamic[1]}`;
  return segment;
}

export function compilePattern(path: string): CompiledPattern {
  const keys: string[] = [];
  let specificity = 0;
  const segments = path.split('/').filter((s) => s.length > 0);

  const parts = segments.map((segment) => {
    if (segment.startsWith('*')) {
      keys.push(segment.slice(1));
      specificity += 1;
      return '(.*)';
    }
    if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      specificity += 10;
      return '([^/]+)';
    }
    specificity += 100;
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  return {
    source: path,
    regex: new RegExp(`^/${parts.join('/')}/?$`),
    keys,
    specificity,
  };
}

const routes = new Map<string, RouteEntry>();

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
  // raw declaration registers, and `describeRoutes()` is where it surfaces — as a bare TypeError
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
  const suspenseBoundaries = input.suspenseBoundaries ?? 0;
  // Explicit `<TData>`: `isRouteConfig` is a guard over the default `RouteData`, so inference off
  // the narrowed argument would resolve the route's own data generic away here.
  const config = withIslandBudget<TData>(input.config, derived.surface);

  assertModeInvariants(config, {
    file: input.file,
    path,
    surface: derived.surface,
    suspenseBoundaries,
  });

  const existing = routes.get(path);
  if (existing !== undefined && existing.file !== input.file) {
    throw new RouteDuplicateError(
      `${path} is claimed by both ${existing.file} and ${input.file}`,
      `rename or delete one of them — the route table is keyed by URL`,
    );
  }

  const entry: RouteEntry<TData> = {
    file: input.file,
    path,
    surface: derived.surface,
    config,
    suspenseBoundaries,
    // The declaration is the ONLY source. It was `input.islands ?? []`, which nothing ever passed,
    // so `routeJsBytes`'s "what registration declared" half read `[]` on every route in the
    // framework's history — and keeping the input as a fallback would be a second answer to one
    // question that can only ever weaken it: a caller passing `[]` un-weighs a declared island.
    islands: config.islands.map((spec) => spec.moduleId),
    pattern: compilePattern(path),
    // Spread, never assigned: `exactOptionalPropertyTypes` makes an explicit `undefined` a
    // different answer from an absent key, and every reader tests presence.
    ...(input.component === undefined ? {} : { component: input.component }),
  };
  routes.set(path, entry as RouteEntry);
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

export function clearRoutes(): void {
  routes.clear();
}

export function routeCount(): number {
  return routes.size;
}

export function routeEntries(): readonly RouteEntry[] {
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function routeFor(path: string): RouteEntry | undefined {
  return routes.get(path);
}

/**
 * The manifest projection: JSON-safe, sorted by path, identical for identical input.
 * Determinism matters because `sw.js` and the sitemap are diffed across deploys.
 */
export function describeRoutes(): readonly RouteDescriptor[] {
  return routeEntries().map((entry) => ({
    path: entry.path,
    file: entry.file,
    surface: entry.surface,
    mode: entry.config.render,
    offline: entry.config.offline,
    hydrate: entry.config.hydrate,
    revalidateTags: tagKeys(entry.config.revalidate?.tags),
    revalidateTtl: entry.config.revalidate?.ttl ?? null,
    prerenderable: entry.config.prerender !== undefined,
    dynamic: entry.pattern.keys.length > 0,
    hasPolicy: entry.config.policy !== undefined,
    islands: entry.islands,
    budgetJs: entry.config.budget.js ?? null,
    budgetLcp: entry.config.budget.lcp ?? null,
  }));
}

export interface RouteMatch {
  readonly entry: RouteEntry;
  readonly params: RouteParams;
}

/** Most specific pattern wins: static segments > dynamic > catch-all. */
export function matchRoute(pathname: string): RouteMatch | null {
  const candidates = routeEntries()
    .slice()
    .sort((a, b) => b.pattern.specificity - a.pattern.specificity);

  for (const entry of candidates) {
    const match = entry.pattern.regex.exec(pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    let undecodable = false;
    entry.pattern.keys.forEach((key, index) => {
      const value = match[index + 1];
      if (value === undefined) return;
      const decoded = decodeSegment(value);
      if (decoded === undefined) undecodable = true;
      else params[key] = decoded;
    });
    // A segment that will not decode fails only the branch that would have decoded it, exactly as
    // `@ultimat3/http`'s router already answers: a literal route matching the same text still wins,
    // and a pathname nothing else claims is the 404 it always was.
    if (undecodable) continue;
    return { entry, params };
  }
  return null;
}

/**
 * `undefined` for a malformed percent-escape. A pathname is whatever the client typed, and
 * `decodeURIComponent('%zz')` throws a bare `URIError` — no code, no fix line — which escaped
 * `matchRoute` as a 500 and an error-monitor page for somebody's typo.
 *
 * Still exported after `router-client.ts` went with `createRouter`: it is the one answer to "is
 * this segment decodable?" on this side of the wire, and a second copy of it is how one of the two
 * ends up throwing where the other 404s.
 */
export function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
