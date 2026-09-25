// Single responsibility: the `site` and `seo` blocks of `app.config.ts` — the public origin every
// absolute URL a document carries is built from, and the paths `robots.txt` keeps crawlers out of.
// Split from `config.ts` for `config-pwa.ts`' reason: that file sits at its 500-line ceiling.

import { type Input, layered } from './config-merge';

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

export interface SeoConfig {
  readonly robots: SeoRobotsConfig;
}

/** `robots` is NESTED for `AiConfigInput`'s reason: `section` applies a patch one level deep. */
export interface SeoConfigInput {
  readonly robots?: Input<SeoRobotsConfig> | undefined;
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
  for (const path of config.seo.robots.disallow) {
    if (!path.startsWith('/')) issues.push(`seo.robots.disallow entry "${path}" must start with /`);
  }
}
