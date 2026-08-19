// Sitemap generation from the route table. Dynamic routes contribute the URLs
// their `prerender()` enumerates, so the sitemap can never drift from what the
// build actually produced. Splits into an index past the 50,000-URL protocol cap.

import { assert } from '@ultimat3/core';
import { sitemapTooLarge } from './errors';
import { type ChangeFreq, expandRoute, indexableRoutes, type RouteRecord } from './routes';
import { absoluteUrl, attributes, escapeXml } from './xml';

/** Both limits are from the sitemaps.org protocol. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_INDEX_MAX_FILES = 50_000;

export interface SitemapAlternate {
  hreflang: string;
  href: string;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: ChangeFreq;
  priority?: number;
  alternates?: readonly SitemapAlternate[];
}

export interface SitemapFile {
  /** Path relative to the site root, e.g. `/sitemap-1.xml`. */
  path: string;
  xml: string;
  urlCount: number;
}

export interface SitemapResult {
  readonly files: readonly SitemapFile[];
  /** Present only when the URLs did not fit in a single file. */
  readonly index: SitemapFile | undefined;
  readonly urlCount: number;
}

export interface BuildSitemapOptions {
  baseUrl: string;
  /** Locales to emit `xhtml:link` alternates for. */
  locales?: readonly string[];
  /** Defaults to `/{locale}{path}`. */
  localizePath?: (path: string, locale: string) => string;
  /** The locale whose URLs are unprefixed and become `x-default`. */
  defaultLocale?: string;
  maxUrls?: number;
  lastmod?: string;
}

function localize(path: string, locale: string, options: BuildSitemapOptions): string {
  if (locale === options.defaultLocale) return path;
  const fn = options.localizePath ?? ((p: string, l: string) => `/${l}${p === '/' ? '' : p}`);
  return fn(path, locale);
}

/** Every concrete URL the route table produces, with per-locale alternates. */
export async function sitemapUrls(
  routes: readonly RouteRecord[],
  options: BuildSitemapOptions,
): Promise<readonly SitemapUrl[]> {
  const urls: SitemapUrl[] = [];
  const locales = options.locales ?? [];

  for (const route of indexableRoutes(routes)) {
    for (const path of await expandRoute(route)) {
      const alternates: SitemapAlternate[] = locales.map((locale) => ({
        hreflang: locale,
        href: absoluteUrl(options.baseUrl, localize(path, locale, options)),
      }));
      if (alternates.length > 0) {
        alternates.push({
          hreflang: 'x-default',
          href: absoluteUrl(options.baseUrl, path),
        });
      }

      const lastmod = route.lastmod ?? options.lastmod;
      const emitFor =
        locales.length === 0 ? [path] : locales.map((l) => localize(path, l, options));
      for (const localised of emitFor) {
        urls.push({
          loc: absoluteUrl(options.baseUrl, localised),
          ...(lastmod === undefined ? {} : { lastmod }),
          ...(route.changefreq === undefined ? {} : { changefreq: route.changefreq }),
          ...(route.priority === undefined ? {} : { priority: route.priority }),
          ...(alternates.length === 0 ? {} : { alternates }),
        });
      }
    }
  }
  return urls;
}

function renderUrlSet(urls: readonly SitemapUrl[]): string {
  const needsXhtml = urls.some((url) => (url.alternates?.length ?? 0) > 0);
  const ns = needsXhtml
    ? ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"'
    : ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const body = urls
    .map((url) => {
      const parts = [`    <loc>${escapeXml(url.loc)}</loc>`];
      if (url.lastmod !== undefined) parts.push(`    <lastmod>${escapeXml(url.lastmod)}</lastmod>`);
      if (url.changefreq !== undefined) {
        parts.push(`    <changefreq>${url.changefreq}</changefreq>`);
      }
      if (url.priority !== undefined) {
        parts.push(`    <priority>${url.priority.toFixed(1)}</priority>`);
      }
      for (const alternate of url.alternates ?? []) {
        parts.push(
          `    <xhtml:link${attributes({ rel: 'alternate', hreflang: alternate.hreflang, href: alternate.href })}/>`,
        );
      }
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset${ns}>\n${body}\n</urlset>\n`;
}

function renderIndex(files: readonly SitemapFile[], options: BuildSitemapOptions): string {
  const body = files
    .map((file) => {
      const loc = escapeXml(absoluteUrl(options.baseUrl, file.path));
      const lastmod =
        options.lastmod === undefined
          ? ''
          : `\n    <lastmod>${escapeXml(options.lastmod)}</lastmod>`;
      return `  <sitemap>\n    <loc>${loc}</loc>${lastmod}\n  </sitemap>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  // The loop advances by `size`, so a non-positive one never moves the cursor: `maxUrls: 0` in a
  // route config turned a build into an infinite loop allocating empty slices until the box ran
  // out of memory. A fractional size is refused for a quieter reason — `slice` truncates it, so
  // the groups silently stop being the size that was asked for.
  assert(
    Number.isSafeInteger(size) && size > 0,
    `a chunk size must be a positive integer, got ${String(size)}: a non-positive step never advances and the loop cannot end`,
    'pass a positive integer — buildSitemap(routes, { baseUrl, maxUrls: 50000 }), the sitemaps.org bound SITEMAP_MAX_URLS already carries',
  );
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export async function buildSitemap(
  routes: readonly RouteRecord[],
  options: BuildSitemapOptions,
): Promise<SitemapResult> {
  const maxUrls = options.maxUrls ?? SITEMAP_MAX_URLS;
  // Refused here and not only in `chunk`, so the answer does not depend on how many URLs the site
  // happens to have today: `maxUrls: 2.5` is a typo whether or not this build has enough routes to
  // reach the split, exactly as a metric refuses `maxSeries: 1.5` at declaration.
  assert(
    Number.isSafeInteger(maxUrls) && maxUrls > 0,
    `buildSitemap({ maxUrls }) must be a positive integer, got ${String(maxUrls)}`,
    'pass a positive integer — buildSitemap(routes, { baseUrl, maxUrls: 50000 }) — or omit it and take SITEMAP_MAX_URLS, the sitemaps.org bound',
  );
  const urls = await sitemapUrls(routes, options);

  if (urls.length <= maxUrls) {
    return {
      files: [{ path: '/sitemap.xml', xml: renderUrlSet(urls), urlCount: urls.length }],
      index: undefined,
      urlCount: urls.length,
    };
  }

  const groups = chunk(urls, maxUrls);
  if (groups.length > SITEMAP_INDEX_MAX_FILES) {
    throw sitemapTooLarge(groups.length, SITEMAP_INDEX_MAX_FILES);
  }

  const files: SitemapFile[] = groups.map((group, position) => ({
    path: `/sitemap-${position + 1}.xml`,
    xml: renderUrlSet(group),
    urlCount: group.length,
  }));

  return {
    files,
    index: {
      path: '/sitemap.xml',
      xml: renderIndex(files, options),
      urlCount: files.length,
    },
    urlCount: urls.length,
  };
}
