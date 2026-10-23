// Single responsibility: the `site` and `seo` blocks of `app.config.ts` — the public origin every
// absolute URL a document carries is built from, and the paths `robots.txt` keeps crawlers out of.
// Split from `config.ts` for `config-pwa.ts`' reason: that file sits at its 500-line ceiling.

import { type Input, layered } from './config-merge';
import { robotsGroupIssues, robotsPathIssues } from './config-robots';
import {
  SITEMAP_PAGE_SIZE_MAX,
  type SitemapSectionConfig,
  sitemapSectionIssues,
} from './config-sitemap';
import { describeValue } from './error-render';

export interface SiteConfig {
  /**
   * `https://www.example.com` — canonical, `og:url`, hreflang and the sitemap are absolute against
   * it. `null` falls back to `APP_URL`, then to the request's own origin; a production build with
   * neither warns, because a relative canonical is one a search engine may resolve against a CDN
   * host or a preview domain.
   */
  readonly origin: string | null;
}

/**
 * One `User-agent` group of a production `robots.txt`. A crawler obeys the ONE group naming it most
 * specifically and ignores `*` beside it, so a group for `GPTBot` replaces `*`'s rules for GPTBot.
 */
export interface SeoRobotsGroup {
  /** `'GPTBot'`, or several sharing one set of rules: `['GPTBot', 'CCBot']`. Never empty. */
  readonly userAgent: string | readonly string[];
  /** Paths this group may fetch, each starting with `/`. */
  readonly allow?: readonly string[] | undefined;
  /** Paths this group may not fetch, each starting with `/`. `['/']` keeps it out entirely. */
  readonly disallow?: readonly string[] | undefined;
  /** Seconds between requests, for the crawlers that read `Crawl-delay`. */
  readonly crawlDelay?: number | undefined;
}

export interface SeoRobotsConfig {
  /**
   * Paths EVERY crawler is kept out of in production, e.g. `['/panel', '/api']` — added to every
   * group, and left out of the sitemap. Each starts with `/`.
   */
  readonly disallow: readonly string[];
  /**
   * Per-crawler groups. Empty (the default): one `User-agent: *` group allowing `/`. Declared, they
   * ARE the file's groups — name `*` among them to give everyone else rules of their own.
   */
  readonly groups: readonly SeoRobotsGroup[];
}

/**
 * Where each sitemap `<lastmod>` comes from. `'none'` (the default): no `<lastmod>`, as before.
 * `'git'`: the last commit that touched the route's source file, read with `git log` — and the
 * file's mtime where the process has no work tree (a container image). `'mtime'`: the file's mtime.
 * `'build'`: one timestamp for every URL, the moment the process built its sitemap.
 */
export type SitemapLastmod = 'none' | 'git' | 'mtime' | 'build';

export const SITEMAP_LASTMOD_SOURCES: readonly SitemapLastmod[] = ['none', 'git', 'mtime', 'build'];

export interface SeoSitemapConfig {
  /**
   * Public pages OUTSIDE `site/` to list — an `app/` route anyone may open, e.g. `['/verificar']`.
   * Each must match a registered route that declares no policy (checked when the sitemap is built,
   * `X_SITEMAP_EXTRA_INVALID`), and is listed per routed locale with hreflang alternates exactly
   * as a `site/` page is.
   */
  readonly extra: readonly string[];
  readonly lastmod: SitemapLastmod;
  /**
   * Named parts of a sitemap index. Empty (the default): one `/sitemap.xml` urlset, split only past
   * a cap. Any section declared: `/sitemap.xml` is a `<sitemapindex>` of `/sitemaps/<name>-<n>.xml`,
   * the pages no section matches under `pages`.
   */
  readonly sections: readonly SitemapSectionConfig[];
  /** `<url>` entries per sitemap file. Default and ceiling: 50,000, the sitemaps.org cap. */
  readonly pageSize: number;
}

export interface SeoConfig {
  readonly robots: SeoRobotsConfig;
  readonly sitemap: SeoSitemapConfig;
}

/** `robots` is NESTED for `AiConfigInput`'s reason: `section` applies a patch one level deep. */
export interface SeoConfigInput {
  readonly robots?: Input<SeoRobotsConfig> | undefined;
  readonly sitemap?: Input<SeoSitemapConfig> | undefined;
}

export interface SiteSections {
  readonly site: SiteConfig;
  readonly seo: SeoConfig;
}

export interface SiteSectionsInput {
  readonly site?: Input<SiteConfig> | undefined;
  readonly seo?: SeoConfigInput | undefined;
}

/** Both sections, every layer applied key by key over the defaults. */
export function mergeSite(layers: readonly SiteSectionsInput[]): SiteSections {
  return {
    site: layered<SiteConfig>(
      { origin: null },
      layers.map((layer) => layer.site),
    ),
    seo: {
      robots: layered<SeoRobotsConfig>(
        { disallow: [], groups: [] },
        layers.map((layer) => layer.seo?.robots),
      ),
      sitemap: layered<SeoSitemapConfig>(
        { extra: [], lastmod: 'none', sections: [], pageSize: SITEMAP_PAGE_SIZE_MAX },
        layers.map((layer) => layer.seo?.sitemap),
      ),
    },
  };
}

/**
 * An origin is scheme + host (+ port) and nothing else: a path would be doubled into every URL built
 * against it, and a scheme other than http(s) is not a page a crawler can fetch.
 */
function originIssue(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `site.origin "${origin}" is not an absolute URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `site.origin "${origin}" must be http:// or https://`;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return `site.origin "${origin}" must be an origin only — no path, query or fragment`;
  }
  return undefined;
}

/** Appends every refusal the two sections earn to `issues`, `config.ts`' one list. */
export function siteIssues(config: SiteSections, issues: string[]): void {
  const origin = config.site.origin;
  if (origin !== null) {
    const issue = originIssue(origin);
    if (issue !== undefined) issues.push(issue);
  }
  issues.push(...robotsPathIssues('seo.robots.disallow', config.seo.robots.disallow));
  issues.push(...robotsGroupIssues(config.seo.robots.groups));
  for (const path of config.seo.sitemap.extra as readonly unknown[]) {
    if (typeof path !== 'string') {
      issues.push(`seo.sitemap.extra entry must be a path string, not ${describeValue(path)}`);
      continue;
    }
    // A PATH, never a URL: every `<loc>` is built against the one declared origin, and a query or
    // a fragment names a variant of a page, which a sitemap lists by its canonical URL alone.
    if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) {
      issues.push(
        `seo.sitemap.extra entry "${path}" must be a path starting with / — no origin, query or fragment`,
      );
    }
  }
  if (!SITEMAP_LASTMOD_SOURCES.includes(config.seo.sitemap.lastmod)) {
    issues.push(
      `seo.sitemap.lastmod "${String(config.seo.sitemap.lastmod)}" must be one of ${SITEMAP_LASTMOD_SOURCES.join(', ')}`,
    );
  }
  issues.push(...sitemapSectionIssues(config.seo.sitemap.sections, config.seo.sitemap.pageSize));
}
