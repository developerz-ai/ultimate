// The route-table shape @ultimat3/seo consumes. Emitted by the framework into
// `x.manifest.json`; every checker here reports against `file`, so an agent can
// open the exact source rather than guess which route a URL came from.

import type { RouteMeta } from './meta';

export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';

/** `site/` is the only surface SEO applies to; `app/` is behind auth. */
export type Surface = 'site' | 'app' | 'api';

export type ChangeFreq = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export interface RouteBudget {
  /** Byte budgets accept `'40kb'` or a raw number of bytes. */
  js?: string | number;
  css?: string | number;
  /** Milliseconds. */
  lcp?: number;
  /** Unitless layout-shift score. */
  cls?: number;
  /** Milliseconds. */
  inp?: number;
}

export interface RouteRecord {
  /** URL pattern, e.g. `/blog/:slug`. */
  path: string;
  /** Source file relative to the app root — named verbatim in every error. */
  file: string;
  surface: Surface;
  render: RenderMode;
  meta?: RouteMeta;
  /** Concrete paths for a dynamic route, from `defineRoute({ prerender })`. */
  prerender?: () => readonly string[] | Promise<readonly string[]>;
  budget?: RouteBudget;
  /** Keep out of the sitemap and emit `noindex`. */
  noindex?: boolean;
  lastmod?: string;
  changefreq?: ChangeFreq;
  /** 0.0–1.0. Omit unless the site genuinely has a priority hierarchy. */
  priority?: number;
}

export function isDynamic(path: string): boolean {
  return path.includes(':') || path.includes('*');
}

/** Routes that should appear in a sitemap: public, indexable, not app-only. */
export function indexableRoutes(routes: readonly RouteRecord[]): readonly RouteRecord[] {
  return routes.filter(
    (route) =>
      route.surface === 'site' && route.noindex !== true && route.meta?.robots?.index !== false,
  );
}

/** Every concrete URL a route resolves to, expanding `prerender()`. */
export async function expandRoute(route: RouteRecord): Promise<readonly string[]> {
  if (!isDynamic(route.path)) return [route.path];
  if (route.prerender === undefined) return [];
  return await route.prerender();
}
