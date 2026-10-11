// The route-table shape @ultimat3/seo consumes. Emitted by the framework into
// `x.manifest.json`; every checker here reports against `file`, so an agent can
// open the exact source rather than guess which route a URL came from.

import type { RenderMode } from '@ultimat3/core';
import type { RouteMeta } from './meta';

/** `site/` is the only surface SEO applies to; `app/` is behind auth. */
export type Surface = 'site' | 'app' | 'api';

export type ChangeFreq = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

/**
 * One concrete page of a route, as a sitemap lists it. A bare string is the same thing with nothing
 * to add: `'/blog/a'` is `{ path: '/blog/a' }`.
 */
export interface SitemapPage {
  /** The concrete path, WITHOUT a locale prefix: `/blog/a`. */
  readonly path: string;
  /**
   * When this page last changed: a `Date`, or ISO 8601 with an explicit zone (`2026-10-01`,
   * `2026-10-01T15:04:05Z`). Written as W3C Datetime in UTC; wins over the route's own `lastmod`.
   */
  readonly lastmod?: string | Date;
  /**
   * The locales this page is LISTED in — one `<url>` each, cross-linked with hreflang among
   * themselves only. Omitted: every locale the sitemap is built for. Empty: listed nowhere.
   */
  readonly locales?: readonly string[];
}

export interface RouteRecord {
  /** URL pattern, e.g. `/blog/:slug`. */
  path: string;
  /** Source file relative to the app root — named verbatim in every error. */
  file: string;
  surface: Surface;
  render: RenderMode;
  meta?: RouteMeta;
  /** The route's concrete pages, from `defineRoute({ prerender })` — required for a dynamic one. */
  prerender?: () => readonly (string | SitemapPage)[] | Promise<readonly (string | SitemapPage)[]>;
  /**
   * The locales every page of this route is listed in, unless the page names its own
   * (`SitemapPage.locales`). Omitted: every locale the sitemap is built for.
   */
  locales?: readonly string[];
  /** Keep out of the sitemap and emit `noindex`. */
  noindex?: boolean;
  /**
   * A public page OUTSIDE `site/` the app asked to list (`seo.sitemap.extra` in `app.config.ts`):
   * indexable although its surface is `app`. The only way an `app/` page reaches a sitemap.
   */
  sitemap?: boolean;
  lastmod?: string;
  changefreq?: ChangeFreq;
  /** 0.0–1.0. Omit unless the site genuinely has a priority hierarchy. */
  priority?: number;
}

export function isDynamic(path: string): boolean {
  return path.includes(':') || path.includes('*');
}

/** Routes that should appear in a sitemap: public, indexable, `site/` or listed by the app. */
export function indexableRoutes(routes: readonly RouteRecord[]): readonly RouteRecord[] {
  return routes.filter(
    (route) =>
      (route.surface === 'site' || route.sitemap === true) &&
      route.noindex !== true &&
      route.meta?.robots?.index !== false,
  );
}

/**
 * Every concrete page a route resolves to, each in the one object form. A route that declares
 * `prerender()` is the pages it answers — with or without params: a page with none may still say
 * its own `lastmod` and `locales` there. Without one, a static path is its one page and a dynamic
 * one is none.
 */
export async function expandRoutePages(route: RouteRecord): Promise<readonly SitemapPage[]> {
  if (route.prerender === undefined) return isDynamic(route.path) ? [] : [{ path: route.path }];
  return (await route.prerender()).map((page) =>
    typeof page === 'string' ? { path: page } : page,
  );
}

/** Every concrete URL a route resolves to, expanding `prerender()`. */
export async function expandRoute(route: RouteRecord): Promise<readonly string[]> {
  return (await expandRoutePages(route)).map((page) => page.path);
}
