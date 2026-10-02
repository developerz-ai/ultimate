// Single responsibility: the `site` and `seo` blocks of `app.config.ts` — the public origin every
// absolute URL a document carries is built from, and the paths `robots.txt` keeps crawlers out of.
// Split from `config.ts` for `config-pwa.ts`' reason: that file sits at its 500-line ceiling.

import { type Input, layered } from './config-merge';
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

export interface SeoRobotsConfig {
  /** Paths `robots.txt` disallows in production, e.g. `['/panel', '/api']`. Each starts with `/`. */
  readonly disallow: readonly string[];
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
        { disallow: [] },
        layers.map((layer) => layer.seo?.robots),
      ),
      sitemap: layered<SeoSitemapConfig>(
        { extra: [], lastmod: 'none' },
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
  // `unknown` entries: an untyped config reaches here with whatever it listed, and `5.startsWith`
  // was a native `TypeError` thrown by the validator itself.
  for (const path of config.seo.robots.disallow as readonly unknown[]) {
    if (typeof path !== 'string') {
      issues.push(`seo.robots.disallow entry must be a path string, not ${describeValue(path)}`);
    } else if (!path.startsWith('/')) {
      issues.push(`seo.robots.disallow entry "${path}" must start with /`);
    }
  }
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
}
