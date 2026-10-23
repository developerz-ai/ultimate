// `robots.txt` and `sitemap.xml`, off the route table: ONE answer for the static export
// (`apps/web/prerender.ts` writes it into the artifact) and the running web role (`seo-routes.ts`
// serves it), so a crawler reads the same two files from a CDN and from a container.

import type { Environment, SeoRobotsGroup, SeoSitemapConfig } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import { localizedPath, unlocalizedPath } from '@ultimat3/i18n';
import { appLocaleSet } from '@ultimat3/i18n/app-catalogs';
import type { RouteEntry } from '@ultimat3/render';
import { routeEntries } from '@ultimat3/render';
import { enumeratePrerenderEntries, fillPath } from '@ultimat3/render/server';
import type { RouteRecord, SitemapFile, SitemapPage } from '@ultimat3/seo';
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
   * the same list, enumerated by the same function the prerenderer calls. Given, `prerender()` is
   * still asked what each page says of ITSELF (`lastmod`, `locales`); the list stays this one.
   */
  readonly pagesFor?: ((routePath: string) => readonly string[]) | undefined;
  /**
   * `seo.robots.disallow` from `app.config.ts` (`loadSiteSettings`). Added to the production
   * `User-agent: *` group; a non-production `robots.txt` still disallows everything.
   */
  readonly disallow?: readonly string[] | undefined;
  /**
   * `seo.robots.groups` from `app.config.ts` (`loadSiteSettings`): the production file's per-crawler
   * groups. They shape `robots.txt` alone — the sitemap is filtered by `disallow`, every crawler's.
   */
  readonly robotsGroups?: readonly SeoRobotsGroup[] | undefined;
  /**
   * `seo.sitemap` from `app.config.ts` (`loadSiteSettings`): the public `app/` pages to list beside
   * the `site/` ones, where each `<lastmod>` comes from, and the sections and page size of an
   * index. Omitted: `site/` pages, no `<lastmod>`, one urlset.
   */
  readonly sitemap?: SiteSeoSitemap | undefined;
  /** The app root the route files are relative to — read for `lastmod: 'git' | 'mtime'`. */
  readonly root?: string | undefined;
}

/**
 * `seo.sitemap` as `siteSeo` takes it: `sections` and `pageSize` optional, so a caller that wrote
 * `{ extra, lastmod }` before either existed still compiles and still gets the one urlset.
 */
export type SiteSeoSitemap = Pick<SeoSitemapConfig, 'extra' | 'lastmod'> &
  Partial<Pick<SeoSitemapConfig, 'sections' | 'pageSize'>>;

const NO_SITEMAP_SETTINGS: SiteSeoSitemap = { extra: [], lastmod: 'none' };

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
 * A route's pages, UNPREFIXED and once each, with what `prerender()` said of each one. A
 * static export's report lists every locale's copy (`/blog/a` and `/en/blog/a`), and the sitemap
 * localizes each page itself — reading the prefixed copies back as pages of their own listed
 * `/en/en/blog/a`.
 */
const pagesOf = async (
  entry: RouteEntry,
  options: SiteSeoOptions,
): Promise<readonly SitemapPage[]> => {
  const said = (await enumeratePrerenderEntries(entry)).map(
    (page): SitemapPage => ({
      path: fillPath(entry.pattern.source, page.params),
      ...(page.lastmod === undefined ? {} : { lastmod: page.lastmod }),
      ...(page.locales === undefined ? {} : { locales: page.locales }),
    }),
  );
  // Only a DYNAMIC route's list is the report's: a page with no params is listed whether or not
  // this build emitted it (an `isr` one is rendered by the server), exactly as before.
  if (options.pagesFor === undefined || !isDynamic(entry.path)) return said;
  const byPath = new Map(said.map((page) => [page.path, page]));
  const emitted = new Set(options.pagesFor(entry.path).map((path) => unlocalizedPath(path)));
  return [...emitted].map((path) => byPath.get(path) ?? { path });
};

/**
 * What a page's own `meta` says about being indexed, per locale: the record's `meta` when every
 * locale agrees, its `locales` when only some may be indexed. `robots: { index: false }` in ONE
 * locale used to leave that copy listed and every other copy's hreflang pointing at it — the read
 * was made once, in no locale at all.
 */
async function indexability(
  locales: readonly string[],
): Promise<(path: string) => Pick<RouteRecord, 'meta' | 'locales'>> {
  if (locales.length < 2) {
    const metaByPath = new Map((await readSiteMeta()).records.map((r) => [r.path, r.meta]));
    return (path) => {
      const meta = metaByPath.get(path);
      return meta === undefined ? {} : { meta };
    };
  }
  const scans = new Map<string, Map<string, RouteRecord['meta']>>();
  // One locale at a time: each scan runs every route's `meta` inside that locale's context.
  for (const locale of locales) {
    scans.set(locale, new Map((await readSiteMeta(locale)).records.map((r) => [r.path, r.meta])));
  }
  return (path) => {
    const listed = locales.filter(
      (locale) => scans.get(locale)?.get(path)?.robots?.index !== false,
    );
    if (listed.length === locales.length) return {};
    // No locale may be indexed: the `noindex` itself is what keeps the route out.
    if (listed.length === 0) return { meta: { robots: { index: false } } };
    return { locales: listed };
  };
}

/**
 * The public `site/` routes as `@ultimat3/seo` reads them. `meta` is carried where it resolves
 * without a request (`readSiteMeta`), which is what lets a page's own `robots: { index: false }`
 * keep it out of the sitemap — a page that asks crawlers to stay away must not be listed for them.
 * A route with params or a `load` resolves no `meta` here: its pages say it per entry (`locales`).
 */
async function publicSiteRoutes(
  options: SiteSeoOptions,
  stamp: Stamp,
  locales: readonly string[],
): Promise<readonly RouteRecord[]> {
  const indexed = await indexability(locales);
  return routeEntries()
    .filter(isPublicSite)
    .map((entry) => ({
      path: entry.path,
      file: entry.file,
      surface: 'site' as const,
      render: entry.config.render,
      ...indexed(entry.path),
      ...(isDynamic(entry.path) || entry.config.prerender !== undefined
        ? { prerender: () => pagesOf(entry, options) }
        : {}),
      ...stamp(entry.file),
    }));
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
    ...(await publicSiteRoutes(options, stamp, locales)),
    ...extraRoutes(settings.extra, stamp),
  ];
  const sitemap = await buildSitemap(routes, {
    baseUrl: options.baseUrl,
    // A URL `robots.txt` keeps crawlers out of is not handed to them here: one config, two files.
    ...(options.disallow === undefined ? {} : { disallow: options.disallow }),
    ...(settings.sections === undefined ? {} : { sections: settings.sections }),
    ...(settings.pageSize === undefined ? {} : { maxUrls: settings.pageSize }),
    ...(locales.length < 2
      ? {}
      : {
          locales,
          defaultLocale,
          localizePath: (path: string, locale: string) =>
            localizedPath(path, locale, defaultLocale),
        }),
  });
  // With sections, or past a protocol cap, `files` are `/sitemaps/*.xml` and the index is
  // `/sitemap.xml`; otherwise `files` is that one file and there is no index.
  const sitemaps = sitemap.index === undefined ? sitemap.files : [sitemap.index, ...sitemap.files];
  const robots = buildRobots({
    baseUrl: options.baseUrl,
    sitemaps: [SITEMAP_PATH],
    ...(options.disallow === undefined ? {} : { disallow: options.disallow }),
    ...(options.robotsGroups === undefined ? {} : { groups: options.robotsGroups }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  return { robots, sitemaps };
}
