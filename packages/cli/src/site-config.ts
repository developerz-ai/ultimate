// The public origin and the crawler rules out of `app.config.ts` — `site.origin` and
// `seo.robots.disallow` — and the one resolution of "which origin is this site served on" every
// absolute URL a document, a sitemap or a robots file carries is built against. Read off the one
// loader (`app-config-load.ts`).

import type { Environment, SeoSitemapConfig } from '@ultimat3/core';
import { loadAppConfig } from './app-config-load';

export interface SiteSettings {
  /** `site.origin`, trailing slash removed; `null` when the app declares none. */
  readonly origin: string | null;
  /** `seo.robots.disallow` — the paths a production `robots.txt` keeps crawlers out of. */
  readonly disallow: readonly string[];
  /** `seo.sitemap` — public `app/` pages to list, and where `<lastmod>` comes from. */
  readonly sitemap: SeoSitemapConfig;
}

export const NO_SITE_SETTINGS: SiteSettings = {
  origin: null,
  disallow: [],
  sitemap: { extra: [], lastmod: 'none' },
};

const trimSlash = (origin: string): string => origin.replace(/\/+$/, '');

export async function loadSiteSettings(root: string): Promise<SiteSettings> {
  const config = await loadAppConfig(root);
  if (config === undefined) return NO_SITE_SETTINGS;
  const { origin } = config.site;
  return {
    origin: origin === null ? null : trimSlash(origin),
    disallow: [...config.seo.robots.disallow],
    sitemap: config.seo.sitemap,
  };
}

/**
 * The declared public origin: `APP_URL` (what the runtime already names it — OAuth's redirect, the
 * sync node's admitted origin), then `SITE_ORIGIN` (the static build's), then `site.origin`.
 * The environment first because one image is deployed to staging and production under two
 * origins; the config line is what a deploy that sets neither falls back to. `undefined` when
 * nothing names one — the caller decides whether the request's own origin will do.
 */
export function publicOrigin(
  env: Readonly<Record<string, string | undefined>>,
  site: SiteSettings,
): string | undefined {
  for (const key of ['APP_URL', 'SITE_ORIGIN']) {
    const declared = env[key]?.trim() ?? '';
    if (declared !== '') return trimSlash(declared);
  }
  return site.origin ?? undefined;
}

/**
 * The sentence a production build prints when no origin was declared. Every canonical, `og:url`,
 * hreflang and sitemap `<loc>` is then built against a placeholder, and a search engine indexes a
 * page whose canonical names a host the site is not on. A warning, not a refusal: a production
 * build on a laptop is how a deploy is rehearsed.
 */
export function originWarning(environment: Environment, declared: string | undefined): string[] {
  if (environment !== 'production' || declared !== undefined) return [];
  return [
    'no public origin: set APP_URL (or SITE_ORIGIN) or `site: { origin }` in app.config.ts — ' +
      'canonical, og:url, hreflang and the sitemap are absolute against a placeholder',
  ];
}
