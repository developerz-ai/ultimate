// Sitemap generation from the route table. Dynamic routes contribute the pages their `prerender()`
// enumerates, so the sitemap can never drift from what the build actually produced. One urlset —
// split into an index past a protocol cap — or, with `sections`, an index of named, paginated parts.

import { assert, SITEMAP_DEFAULT_SECTION } from '@ultimat3/core';
import { sitemapEntryInvalid, sitemapTooLarge } from './errors';
import { hreflangTag } from './locale-tags';
import { disallowMatcher } from './robots';
import { expandRoutePages, indexableRoutes, type RouteRecord, type SitemapPage } from './routes';
import { SITEMAP_DATETIME_FORMS, sitemapDatetime } from './sitemap-datetime';
import { assertSections, type SitemapSection, sectionOf } from './sitemap-sections';
import {
  indexXml,
  paginate,
  type SitemapAlternate,
  type SitemapPageXml,
  type SitemapUrl,
} from './sitemap-xml';
import { absoluteUrl } from './xml';

export type { SitemapAlternate, SitemapUrl } from './sitemap-xml';
export { chunk } from './sitemap-xml';

/** All three limits are from the sitemaps.org protocol; the byte one is of the UNCOMPRESSED file. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_INDEX_MAX_FILES = 50_000;
export const SITEMAP_MAX_BYTES = 52_428_800;

/**
 * Where the parts of a sitemap index live: `/sitemaps/1.xml`, … for a split, `/sitemaps/blog-1.xml`,
 * … for a section — one directory, so a running server answers every part from ONE route
 * (`/sitemaps/:file`). `/sitemap-N.xml` needed a parameter inside a segment, which no router here
 * has, and every part 404'd from the web role.
 */
export const SITEMAP_PARTS_DIR = '/sitemaps';

export interface SitemapFile {
  /** Path relative to the site root: `/sitemap.xml`, or a part, `/sitemaps/blog-1.xml`. */
  path: string;
  xml: string;
  urlCount: number;
  /** The newest `<lastmod>` inside a urlset — what the index says of it. Absent when none has one. */
  lastmod?: string;
}

export interface SitemapResult {
  readonly files: readonly SitemapFile[];
  /** Present when `/sitemap.xml` is an index: sections were declared, or one file did not fit. */
  readonly index: SitemapFile | undefined;
  readonly urlCount: number;
}

export interface BuildSitemapOptions {
  baseUrl: string;
  /** Locales to emit `xhtml:link` alternates for. */
  locales?: readonly string[];
  /** Defaults to `/{locale}{path}`. */
  localizePath?: (path: string, locale: string) => string;
  /**
   * The locale whose URLs are unprefixed and become `x-default`. **Omitted, no `x-default` is
   * emitted at all** — there is no unprefixed URL in the sitemap for it to name.
   */
  defaultLocale?: string;
  /** `<url>` entries per file — the page size of a section. Defaults to the protocol's 50,000. */
  maxUrls?: number;
  /** Bytes of XML per file. Defaults to the protocol's 50 MB; a test passes less. */
  maxBytes?: number;
  lastmod?: string;
  /**
   * Named parts. Declared, `/sitemap.xml` is ALWAYS an index — of `/sitemaps/<name>-<n>.xml`, the
   * pages no section matches under `pages` — whatever the URL count. Omitted or empty: one urlset.
   */
  sections?: readonly SitemapSection[];
  /**
   * `robots.txt` `Disallow:` rules. A URL one of them matches is not listed, and leaves its
   * hreflang cluster: a crawler told to stay out of a URL must not be handed it to fetch.
   */
  disallow?: readonly string[];
  /** The moment a page's `lastmod` may not be later than. Omitted: when the sitemap is built. */
  now?: Date;
}

function localize(path: string, locale: string, options: BuildSitemapOptions): string {
  if (locale === options.defaultLocale) return path;
  const fn = options.localizePath ?? ((p: string, l: string) => `/${l}${p === '/' ? '' : p}`);
  return fn(path, locale);
}

/**
 * The path `x-default` may point at: the default locale's own, and only when this route emits it.
 * `undefined` when no `defaultLocale` was declared, or when it names a locale outside `locales` —
 * in both cases the URL it would carry is one the sitemap does not contain.
 *
 * Matched on the LOCALE, never on the path. Recomputing the default's URL and asking whether any
 * entry carries it made a `localizePath` that maps two locales onto one URL answer yes for a
 * `defaultLocale` outside `locales`: the href existed, but it belonged to another locale, so
 * `x-default` spoke for a locale this cluster does not carry. The entry that emits it is the only
 * thing that can prove it exists, so read the answer off that entry.
 */
function defaultLocaleUrl(
  localised: readonly { readonly locale: string; readonly path: string }[],
  options: BuildSitemapOptions,
): string | undefined {
  return localised.find((entry) => entry.locale === options.defaultLocale)?.path;
}

/** One page and every `<url>` it is listed as — its locale copies, which file and move together. */
interface Cluster {
  /** The page's UNPREFIXED path: what a section matches and what a section sorts by. */
  readonly page: string;
  readonly urls: readonly SitemapUrl[];
}

/**
 * The locales `page` is listed in, in the SITEMAP's order. A name outside `locales` is refused: a
 * typo (`en-us` for `en`) would otherwise drop the page from a locale without a word.
 */
function listedLocales(
  route: RouteRecord,
  page: SitemapPage,
  locales: readonly string[],
): readonly string[] {
  const wanted = page.locales ?? route.locales;
  if (wanted === undefined) return locales;
  const unknown = wanted.find((locale) => !locales.includes(locale));
  if (unknown !== undefined) {
    throw sitemapEntryInvalid(
      route.file,
      page.path,
      `the locale "${unknown}", which is not one of the routed locales (${locales.join(', ')})`,
    );
  }
  return locales.filter((locale) => wanted.includes(locale));
}

function lastmodOf(
  route: RouteRecord,
  page: SitemapPage,
  options: BuildSitemapOptions,
  now: Date,
): string | undefined {
  if (page.lastmod === undefined) return route.lastmod ?? options.lastmod;
  const lastmod = sitemapDatetime(page.lastmod, now);
  if (lastmod !== undefined) return lastmod;
  const written =
    page.lastmod instanceof Date ? 'an invalid Date' : JSON.stringify(String(page.lastmod));
  throw sitemapEntryInvalid(
    route.file,
    page.path,
    `the lastmod ${written}, which is not ${SITEMAP_DATETIME_FORMS}`,
  );
}

async function sitemapClusters(
  routes: readonly RouteRecord[],
  options: BuildSitemapOptions,
): Promise<readonly Cluster[]> {
  const clusters: Cluster[] = [];
  const locales = options.locales ?? [];
  const disallowed = disallowMatcher(options.disallow ?? []);
  const now = options.now ?? new Date();

  for (const route of indexableRoutes(routes)) {
    for (const page of await expandRoutePages(route)) {
      const path = page.path;
      // Localised once, then read three times — the alternates, the `x-default` candidate and the
      // `<loc>`s below are three questions with one answer, and they drifted apart when each
      // computed its own. Trimmed HERE, to the locales the page is listed in and the URLs a
      // crawler may fetch, so all three read the same trimmed list.
      const localised = listedLocales(route, page, locales)
        .map((locale) => ({ locale, path: localize(path, locale, options) }))
        .filter((entry) => !disallowed(entry.path));
      // A page left in ONE locale of several has no alternate to name: the cluster is the page.
      // (A sitemap built for one locale keeps its cluster of one — it always wrote it.)
      const alone = localised.length === 1 && locales.length > 1;
      const alternates: SitemapAlternate[] = alone
        ? []
        : localised.map((entry) => ({
            // BCP 47 region form (`es-CO`), the spelling `renderMeta` puts in the head: one cluster,
            // one vocabulary, whether a crawler reads the page or the sitemap.
            hreflang: hreflangTag(entry.locale),
            href: absoluteUrl(options.baseUrl, entry.path),
          }));
      // `x-default` only when it names a URL THIS sitemap lists. It was the bare `path` for every
      // route: with `locales` set and no `defaultLocale`, every `<loc>` is prefixed and the
      // unprefixed path is one the sitemap never mentions — an hreflang cluster pointing at a URL
      // outside itself, which is the shape a search engine drops the whole cluster for. Same rule
      // as `meta.ts`'s `hreflangSet`, which takes the fallback href explicitly rather than
      // assuming one exists.
      const fallback = defaultLocaleUrl(localised, options);
      if (alternates.length > 0 && fallback !== undefined) {
        alternates.push({ hreflang: 'x-default', href: absoluteUrl(options.baseUrl, fallback) });
      }

      const lastmod = lastmodOf(route, page, options, now);
      // No locales at all: the page is its one URL — unless it asked to be listed nowhere.
      const nowhere = (page.locales ?? route.locales)?.length === 0;
      const unlocalised = nowhere || disallowed(path) ? [] : [path];
      const emitFor = locales.length === 0 ? unlocalised : localised.map((entry) => entry.path);
      const urls = emitFor.map((emitted) => ({
        loc: absoluteUrl(options.baseUrl, emitted),
        ...(lastmod === undefined ? {} : { lastmod }),
        ...(route.changefreq === undefined ? {} : { changefreq: route.changefreq }),
        ...(route.priority === undefined ? {} : { priority: route.priority }),
        ...(alternates.length === 0 ? {} : { alternates }),
      }));
      if (urls.length > 0) clusters.push({ page: path, urls });
    }
  }
  return clusters;
}

/** Every concrete URL the route table produces, with per-locale alternates. */
export async function sitemapUrls(
  routes: readonly RouteRecord[],
  options: BuildSitemapOptions,
): Promise<readonly SitemapUrl[]> {
  return (await sitemapClusters(routes, options)).flatMap((cluster) => cluster.urls);
}

/** The newest `<lastmod>` among `urls`, as written — compared as instants, not as text. */
function newestLastmod(urls: readonly SitemapUrl[]): string | undefined {
  let newest: string | undefined;
  let at = Number.NEGATIVE_INFINITY;
  for (const url of urls) {
    const time = url.lastmod === undefined ? Number.NaN : Date.parse(url.lastmod);
    if (Number.isFinite(time) && time > at) {
      at = time;
      newest = url.lastmod;
    }
  }
  return newest;
}

const fileOf = (path: string, page: SitemapPageXml): SitemapFile => {
  const lastmod = newestLastmod(page.urls);
  return {
    path,
    xml: page.xml,
    urlCount: page.urls.length,
    ...(lastmod === undefined ? {} : { lastmod }),
  };
};

const comparePages = (a: Cluster, b: Cluster): number =>
  a.page < b.page ? -1 : a.page > b.page ? 1 : 0;

/**
 * The files of a sectioned sitemap, the default section first and the rest in declaration order.
 * Inside a section pages are SORTED by path: the bytes then depend on which pages exist and never
 * on the order a query happened to return them in, so a crawler re-reading a page of a section
 * diffs it against the same neighbours. A section with nothing in it writes no file.
 */
function sectionFiles(
  clusters: readonly Cluster[],
  sections: readonly SitemapSection[],
  maxUrls: number,
  maxBytes: number,
): readonly SitemapFile[] {
  const names = [SITEMAP_DEFAULT_SECTION, ...sections.map((section) => section.name)];
  const filed = new Map<string, Cluster[]>(names.map((name) => [name, []]));
  for (const cluster of clusters) filed.get(sectionOf(cluster.page, sections))?.push(cluster);
  return names.flatMap((name) => {
    const urls = (filed.get(name) ?? []).sort(comparePages).flatMap((cluster) => cluster.urls);
    if (urls.length === 0) return [];
    return paginate(urls, maxUrls, maxBytes).map((page, position) =>
      fileOf(`${SITEMAP_PARTS_DIR}/${name}-${String(position + 1)}.xml`, page),
    );
  });
}

export async function buildSitemap(
  routes: readonly RouteRecord[],
  options: BuildSitemapOptions,
): Promise<SitemapResult> {
  const maxUrls = options.maxUrls ?? SITEMAP_MAX_URLS;
  const maxBytes = options.maxBytes ?? SITEMAP_MAX_BYTES;
  // Refused here and not only in `chunk`, so the answer does not depend on how many URLs the site
  // happens to have today: `maxUrls: 2.5` is a typo whether or not this build has enough routes to
  // reach the split, exactly as a metric refuses `maxSeries: 1.5` at declaration.
  assert(
    Number.isSafeInteger(maxUrls) && maxUrls > 0,
    `buildSitemap({ maxUrls }) must be a positive integer, got ${String(maxUrls)}`,
    'pass a positive integer — buildSitemap(routes, { baseUrl, maxUrls: 50000 }) — or omit it and take SITEMAP_MAX_URLS, the sitemaps.org bound',
  );
  assert(
    Number.isSafeInteger(maxBytes) && maxBytes > 0,
    `buildSitemap({ maxBytes }) must be a positive integer, got ${String(maxBytes)}`,
    'pass a positive integer — buildSitemap(routes, { baseUrl, maxBytes: 52428800 }) — or omit it and take SITEMAP_MAX_BYTES, the sitemaps.org bound',
  );
  const sections = options.sections ?? [];
  if (sections.length > 0) assertSections(sections, Math.min(maxUrls, SITEMAP_MAX_URLS));

  const clusters = await sitemapClusters(routes, options);
  const urlCount = clusters.reduce((count, cluster) => count + cluster.urls.length, 0);
  // Counted before a single file is rendered: a site this far past the index cap would otherwise
  // build tens of thousands of documents on the way to a refusal.
  if (Math.ceil(urlCount / maxUrls) > SITEMAP_INDEX_MAX_FILES) {
    throw sitemapTooLarge(Math.ceil(urlCount / maxUrls), SITEMAP_INDEX_MAX_FILES);
  }

  if (sections.length > 0 && urlCount > 0) {
    const files = sectionFiles(clusters, sections, maxUrls, maxBytes);
    if (files.length > SITEMAP_INDEX_MAX_FILES) {
      throw sitemapTooLarge(files.length, SITEMAP_INDEX_MAX_FILES);
    }
    const entries = files.map((file) => ({
      loc: absoluteUrl(options.baseUrl, file.path),
      lastmod: file.lastmod,
    }));
    return {
      files,
      index: { path: '/sitemap.xml', xml: indexXml(entries), urlCount: files.length },
      urlCount,
    };
  }

  const pages = paginate(
    clusters.flatMap((cluster) => cluster.urls),
    maxUrls,
    maxBytes,
  );
  const [only] = pages;
  if (pages.length === 1 && only !== undefined) {
    return { files: [fileOf('/sitemap.xml', only)], index: undefined, urlCount };
  }
  if (pages.length > SITEMAP_INDEX_MAX_FILES) {
    throw sitemapTooLarge(pages.length, SITEMAP_INDEX_MAX_FILES);
  }
  const files = pages.map((page, position) =>
    fileOf(`${SITEMAP_PARTS_DIR}/${String(position + 1)}.xml`, page),
  );
  // An unsectioned split says of every part what the caller said of the build (`options.lastmod`):
  // the bytes it always wrote. Sections are where a part's own newest date is read.
  const entries = files.map((file) => ({
    loc: absoluteUrl(options.baseUrl, file.path),
    lastmod: options.lastmod,
  }));
  return {
    files,
    index: { path: '/sitemap.xml', xml: indexXml(entries), urlCount: files.length },
    urlCount,
  };
}
