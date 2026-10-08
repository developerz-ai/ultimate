// `robots.txt` and `sitemap.xml`, off the route table: ONE answer for the static export
// (`apps/web/prerender.ts` writes it into the artifact) and the running web role (`seo-routes.ts`
// serves it), so a crawler reads the same two files from a CDN and from a container.

import type { Environment, SeoSitemapConfig } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import { localizedPath, unlocalizedPath } from '@ultimat3/i18n';
import { appLocaleSet } from '@ultimat3/i18n/app-catalogs';
import type { RouteEntry } from '@ultimat3/render';
import { routeEntries } from '@ultimat3/render';
import { enumeratePrerender, fillPath } from '@ultimat3/render/server';
import type { RouteRecord, SitemapFile } from '@ultimat3/seo';
import { buildRobots, buildSitemap, isDynamic } from '@ultimat3/seo';
import { readSiteMeta } from './seo-meta';
import { lastmodOf } from './sitemap-lastmod';

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
  /**
   * `seo.robots.disallow` from `app.config.ts` (`loadSiteSettings`). Added to the production
   * `User-agent: *` group; a non-production `robots.txt` still disallows everything.
   */
  readonly disallow?: readonly string[] | undefined;
  /**
   * `seo.sitemap` from `app.config.ts` (`loadSiteSettings`): the public `app/` pages to list beside
   * the `site/` ones, and where each `<lastmod>` comes from. Omitted: `site/` pages, no `<lastmod>`.
   */
  readonly sitemap?: SeoSitemapConfig | undefined;
  /** The app root the route files are relative to — read for `lastmod: 'git' | 'mtime'`. */
  readonly root?: string | undefined;
}

const NO_SITEMAP_SETTINGS: SeoSitemapConfig = { extra: [], lastmod: 'none' };

/** A `seo.sitemap.extra` path that names no public page outside `site/`. */
export class SitemapExtraInvalidError extends UltimateError {
  constructor(path: string, reason: string) {
    super({
      code: 'X_SITEMAP_EXTRA_INVALID',
      cause: `seo.sitemap.extra lists "${path}", which ${reason}`,
      fix: 'x routes --json   # then list in seo.sitemap.extra only a path a registered app/ route without a policy answers',
      meta: { path },
    });
  }
}

export interface SiteSeo {
  readonly robots: string;
  /** Every sitemap file: `/sitemap.xml` alone, or the index at that path first and its parts after. */
  readonly sitemaps: readonly SitemapFile[];
}

/** A `site/` page anyone may fetch. A policy on a `site/` route makes it not public, whatever the surface. */
const isPublicSite = (entry: RouteEntry): boolean =>
  entry.surface === 'site' && entry.config.policy === undefined;

/**
 * A dynamic route's pages, UNPREFIXED and once each. A static export's report lists every locale's
 * copy (`/blog/a` and `/en/blog/a`), and the sitemap localizes each page itself — reading the
 * prefixed copies back as pages of their own listed `/en/en/blog/a`.
 */
const pagesOf = async (entry: RouteEntry, options: SiteSeoOptions): Promise<readonly string[]> => {
  if (options.pagesFor !== undefined) {
    return [...new Set(options.pagesFor(entry.path).map((path) => unlocalizedPath(path)))];
  }
  const params = await enumeratePrerender(entry);
  return params.map((set) => fillPath(entry.pattern.source, set));
};

/**
 * The public `site/` routes as `@ultimat3/seo` reads them. `meta` is carried where it resolves
 * without a request (`readSiteMeta`), which is what lets a page's own `robots: { index: false }`
 * keep it out of the sitemap — a page that asks crawlers to stay away must not be listed for them.
 */
async function publicSiteRoutes(
  options: SiteSeoOptions,
  stamp: Stamp,
): Promise<readonly RouteRecord[]> {
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
        ...stamp(entry.file),
      };
    });
}

type Stamp = (file: string) => { readonly lastmod?: string };

/**
 * The app's `seo.sitemap.extra` paths as records, each resolved to the route that answers it — the
 * most specific match, the router's own tie-break. REFUSED, never skipped, when it names no route,
 * a gated one or a `site/` page (listed already): a sitemap missing a page its
 * author listed is the silent drop, and a gated page in it is a URL a crawler cannot open.
 */
function extraRoutes(extra: readonly string[], stamp: Stamp): readonly RouteRecord[] {
  const entries = routeEntries();
  return [...new Set(extra)].map((path) => {
    const entry = entries
      .filter((candidate) => candidate.pattern.regex.test(path))
      .sort((a, b) => b.pattern.specificity - a.pattern.specificity)[0];
    if (entry === undefined)
      throw new SitemapExtraInvalidError(path, 'no registered route answers');
    if (entry.surface === 'site') {
      throw new SitemapExtraInvalidError(
        path,
        `is the site/ page ${entry.file} — every public site/ page is listed already`,
      );
    }
    if (entry.config.policy !== undefined) {
      throw new SitemapExtraInvalidError(
        path,
        `is answered by ${entry.file}, which declares a policy — a crawler cannot open it`,
      );
    }
    return {
      path,
      file: entry.file,
      surface: 'app' as const,
      render: entry.config.render,
      sitemap: true,
      ...stamp(entry.file),
    };
  });
}

export async function siteSeo(options: SiteSeoOptions): Promise<SiteSeo> {
  // Every routed locale, with `xhtml:link` alternates: one `<url>` per page per locale, each
  // naming the whole cluster and `x-default`. A single-locale app passes none and gets the plain
  // urlset it always had — an alternates cluster of one is noise.
  // The app's declared set — the one the manifest, the worker and the prerender read — never the
  // ambient locale config, which a build process has not configured.
  const root = options.root ?? process.cwd();
  const { locales, defaultLocale } = await appLocaleSet(root);
  const settings = options.sitemap ?? NO_SITEMAP_SETTINGS;
  const stamp: Stamp = (file) => {
    const lastmod = lastmodOf(file, settings.lastmod, root);
    return lastmod === undefined ? {} : { lastmod };
  };
  const routes = [
    ...(await publicSiteRoutes(options, stamp)),
    ...extraRoutes(settings.extra, stamp),
  ];
  const sitemap = await buildSitemap(routes, {
    baseUrl: options.baseUrl,
    ...(locales.length < 2
      ? {}
      : {
          locales,
          defaultLocale,
          localizePath: (path: string, locale: string) =>
            localizedPath(path, locale, defaultLocale),
        }),
  });
  // Past 50,000 URLs `files` are `/sitemaps/<n>.xml` and the index is `/sitemap.xml`; below it,
  // `files` is that one file and there is no index.
  const sitemaps = sitemap.index === undefined ? sitemap.files : [sitemap.index, ...sitemap.files];
  const robots = buildRobots({
    baseUrl: options.baseUrl,
    sitemaps: [SITEMAP_PATH],
    ...(options.disallow === undefined ? {} : { disallow: options.disallow }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return { robots, sitemaps };
}
