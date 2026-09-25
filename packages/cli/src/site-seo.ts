// `robots.txt` and `sitemap.xml`, off the route table: ONE answer for the static export
// (`apps/web/prerender.ts` writes it into the artifact) and the running web role (`seo-routes.ts`
// serves it), so a crawler reads the same two files from a CDN and from a container.

import type { Environment } from '@ultimat3/core';
import type { RouteEntry } from '@ultimat3/render';
import { routeEntries } from '@ultimat3/render';
import { enumeratePrerender, fillPath } from '@ultimat3/render/server';
import type { RouteRecord, SitemapFile } from '@ultimat3/seo';
import { buildRobots, buildSitemap, isDynamic } from '@ultimat3/seo';
import { readSiteMeta } from './seo-meta';

export const ROBOTS_PATH = '/robots.txt';
export const SITEMAP_PATH = '/sitemap.xml';

export interface SiteSeoOptions {
  /** The public origin every `<loc>` and the `Sitemap:` line are absolute against. */
  readonly baseUrl: string;
  /** Omitted: `ULTIMATE_ENV`, read by `@ultimat3/seo` — anything but `production` disallows. */
  readonly environment?: Environment | undefined;
  /**
   * The concrete pages a build EMITTED for a dynamic route. The static export passes its report's,
   * so the sitemap cannot name a page the artifact lacks; absent, `prerender()` is asked — which is
   * the same list, enumerated by the same function the prerenderer calls.
   */
  readonly pagesFor?: ((routePath: string) => readonly string[]) | undefined;
}

export interface SiteSeo {
  readonly robots: string;
  /** Every sitemap file: `/sitemap.xml` alone, or the index at that path first and its parts after. */
  readonly sitemaps: readonly SitemapFile[];
}

/** A `site/` page anyone may fetch. A policy on a `site/` route makes it not public, whatever the surface. */
const isPublicSite = (entry: RouteEntry): boolean =>
  entry.surface === 'site' && entry.config.policy === undefined;

const pagesOf = async (entry: RouteEntry, options: SiteSeoOptions): Promise<readonly string[]> => {
  if (options.pagesFor !== undefined) return options.pagesFor(entry.path);
  const params = await enumeratePrerender(entry);
  return params.map((set) => fillPath(entry.pattern.source, set));
};

/**
 * The public `site/` routes as `@ultimat3/seo` reads them. `meta` is carried where it resolves
 * without a request (`readSiteMeta`), which is what lets a page's own `robots: { index: false }`
 * keep it out of the sitemap — a page that asks crawlers to stay away must not be listed for them.
 */
async function publicSiteRoutes(options: SiteSeoOptions): Promise<readonly RouteRecord[]> {
  const metaByPath = new Map((await readSiteMeta()).records.map((r) => [r.path, r.meta]));
  return routeEntries()
    .filter(isPublicSite)
    .map((entry) => {
      const meta = metaByPath.get(entry.path);
      return {
        path: entry.path,
        file: entry.file,
        surface: 'site' as const,
        render: entry.config.render,
        ...(meta === undefined ? {} : { meta }),
        ...(isDynamic(entry.path) ? { prerender: () => pagesOf(entry, options) } : {}),
      };
    });
}

export async function siteSeo(options: SiteSeoOptions): Promise<SiteSeo> {
  const sitemap = await buildSitemap(await publicSiteRoutes(options), { baseUrl: options.baseUrl });
  // Past 50,000 URLs `files` are `/sitemap-N.xml` and the index is `/sitemap.xml`; below it,
  // `files` is that one file and there is no index.
  const sitemaps = sitemap.index === undefined ? sitemap.files : [sitemap.index, ...sitemap.files];
  const robots = buildRobots({
    baseUrl: options.baseUrl,
    sitemaps: [SITEMAP_PATH],
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return { robots, sitemaps };
}
