// Single responsibility: the XML of a sitemap — one `<urlset>`, one `<sitemapindex>` — and the
// split of a list of URLs into files that each fit BOTH protocol caps, entries and bytes.

import { assert } from '@ultimat3/core';
import type { ChangeFreq } from './routes';
import { attributes, escapeXml } from './xml';

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

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SITEMAP_NS = ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const XHTML_NS = ' xmlns:xhtml="http://www.w3.org/1999/xhtml"';
/** The envelope around the `<url>` entries, at its largest: every byte of it is ASCII. */
const ENVELOPE_BYTES = `${HEAD}<urlset${SITEMAP_NS}${XHTML_NS}>\n\n</urlset>\n`.length;

function urlXml(url: SitemapUrl): string {
  const parts = [`    <loc>${escapeXml(url.loc)}</loc>`];
  if (url.lastmod !== undefined) parts.push(`    <lastmod>${escapeXml(url.lastmod)}</lastmod>`);
  if (url.changefreq !== undefined) parts.push(`    <changefreq>${url.changefreq}</changefreq>`);
  if (url.priority !== undefined) {
    parts.push(`    <priority>${url.priority.toFixed(1)}</priority>`);
  }
  for (const alternate of url.alternates ?? []) {
    parts.push(
      `    <xhtml:link${attributes({ rel: 'alternate', hreflang: alternate.hreflang, href: alternate.href })}/>`,
    );
  }
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

export function urlSetXml(urls: readonly SitemapUrl[]): string {
  const needsXhtml = urls.some((url) => (url.alternates?.length ?? 0) > 0);
  const ns = needsXhtml ? `${SITEMAP_NS}${XHTML_NS}` : SITEMAP_NS;
  return `${HEAD}<urlset${ns}>\n${urls.map(urlXml).join('\n')}\n</urlset>\n`;
}

export interface SitemapIndexEntry {
  /** Absolute. */
  readonly loc: string;
  readonly lastmod?: string | undefined;
}

export function indexXml(entries: readonly SitemapIndexEntry[]): string {
  const body = entries
    .map((entry) => {
      const lastmod =
        entry.lastmod === undefined ? '' : `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`;
      return `  <sitemap>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </sitemap>`;
    })
    .join('\n');
  return `${HEAD}<sitemapindex${SITEMAP_NS}>\n${body}\n</sitemapindex>\n`;
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

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/** One group of at most `maxUrls`, cut again wherever its XML would pass `maxBytes`. */
function splitByBytes(urls: readonly SitemapUrl[], maxBytes: number): SitemapUrl[][] {
  const out: SitemapUrl[][] = [];
  let current: SitemapUrl[] = [];
  let size = ENVELOPE_BYTES;
  for (const url of urls) {
    const cost = bytesOf(urlXml(url)) + 1;
    // A lone URL larger than the cap still gets a file: there is no smaller unit to write.
    if (current.length > 0 && size + cost > maxBytes) {
      out.push(current);
      current = [];
      size = ENVELOPE_BYTES;
    }
    current.push(url);
    size += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export interface SitemapPageXml {
  readonly urls: readonly SitemapUrl[];
  readonly xml: string;
}

/**
 * `urls` as the files that hold them: at most `maxUrls` entries and at most `maxBytes` of XML each,
 * in order. No URL at all is ONE empty urlset — `/sitemap.xml` always answers a document.
 */
export function paginate(
  urls: readonly SitemapUrl[],
  maxUrls: number,
  maxBytes: number,
): readonly SitemapPageXml[] {
  if (urls.length === 0) return [{ urls, xml: urlSetXml(urls) }];
  const pages: SitemapPageXml[] = [];
  for (const group of chunk(urls, maxUrls)) {
    const xml = urlSetXml(group);
    // UTF-8 is at most three bytes per UTF-16 unit: a file this short cannot pass the cap, and the
    // common case never pays for an encode.
    if (xml.length * 3 <= maxBytes || bytesOf(xml) <= maxBytes) {
      pages.push({ urls: group, xml });
      continue;
    }
    for (const part of splitByBytes(group, maxBytes)) {
      pages.push({ urls: part, xml: urlSetXml(part) });
    }
  }
  return pages;
}
