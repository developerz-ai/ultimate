/**
 * The route table — the single source of route truth. File path → URL conventions for
 * `site/`, `app/` and `api/`, plus `describeRoutes()`, the serializable projection that
 * `x.manifest.json`, the `/_x` routes panel, the sitemap and `sw.js` are all generated
 * from. Nothing downstream may keep its own list of routes.
 */

import {
  RouteDuplicateError,
  RouteFileInvalidError,
  RouteUnnormalizedError,
  SurfaceBoundaryError,
} from './errors';
import { assertModeInvariants } from './modes';
import type {
  HydrateStrategy,
  OfflineStrategy,
  RenderMode,
  RouteConfig,
  RouteData,
  RouteParams,
} from './route';
import { isRouteConfig, tagKeys } from './route';
import type { Surface } from './surfaces';
import { surfaceOf } from './surfaces';

/**
 * The one filename a route may carry, per surface. `shared/` is absent on purpose: it is a leaf
 * of helpers with no URL, so a route file there has nowhere to resolve to.
 */
export const ROUTE_FILENAME: Readonly<Partial<Record<Surface, string>>> = Object.freeze({
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
  const surface = surfaceOf(normalized);
  if (surface === null) {
    throw new SurfaceBoundaryError(
      `${file} is not inside a surface directory, so it has no URL and no bundle graph`,
      `move ${file} under site/, app/ or api/`,
    );
  }

  const afterSurface = normalized.slice(normalized.indexOf(`${surface}/`) + surface.length + 1);
  const rawSegments = afterSurface.split('/').filter((s) => s.length > 0);
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
 * Enforced rather than documented (axiom 3): a convention that is not a build error is not a
 * convention. The fix is the move that makes the file a route, spelled out — the directory the
 * author already meant, plus the one filename that surface accepts.
 */
function assertRouteFilename(file: string, surface: Surface, basename: string | undefined): void {
  const expected = ROUTE_FILENAME[surface];
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
    inPlace ? `git mv ${file} ${target}` : `mkdir -p ${stem} && git mv ${file} ${target}`,
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
  readonly islands?: readonly string[];
  /** Override the convention (locale roots, rewrites). Rarely needed. */
  readonly path?: string;
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

  assertModeInvariants(input.config, {
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
    config: input.config,
    suspenseBoundaries,
    islands: input.islands ?? [],
    pattern: compilePattern(path),
  };
  routes.set(path, entry as RouteEntry);
  return entry;
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
    entry.pattern.keys.forEach((key, index) => {
      const value = match[index + 1];
      if (value !== undefined) params[key] = decodeURIComponent(value);
    });
    return { entry, params };
  }
  return null;
}
