// `GET /robots.txt`, `GET /sitemap.xml` and its parts (`/sitemaps/<n>.xml`) from a running web
// role — the files the static export writes, for a deploy that serves its pages from a container.
// Mounted by `x dev` and `runRole` alike, before the app's pages, for `style-routes.ts`' reason.

import { DEFAULT_ENVIRONMENT, type Environment, tryResolveEnvironment } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, jsonResponse, NO_STORE } from '@ultimat3/http';
import { SITEMAP_PARTS_DIR } from '@ultimat3/seo';
import { quoteArg } from './shell-quote';
import { NO_SITE_SETTINGS, publicOrigin, type SiteSettings } from './site-config';
import type { SiteSeo } from './site-seo';
import { ROBOTS_PATH, SITEMAP_PATH, siteSeo } from './site-seo';

export interface SeoRoutesOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `site.origin`, `seo.robots.disallow` and `seo.sitemap` from `app.config.ts` (`loadSiteSettings`). */
  readonly site?: SiteSettings;
  /** The app root route files are relative to — `seo.sitemap.lastmod: 'git' | 'mtime'` reads them. */
  readonly root?: string;
}

/**
 * The public origin — `publicOrigin()`: `APP_URL`, `SITE_ORIGIN`, then `site.origin` — else the
 * request's own. A container behind an ingress sees its pod address as the request's host, which
 * is why the declared origin comes first — a sitemap of `http://10.0.0.7:3000/…` indexes nothing.
 */
function originOf(options: SeoRoutesOptions, request: UltimateRequest): string {
  return publicOrigin(options.env, options.site ?? NO_SITE_SETTINGS) ?? new URL(request.url).origin;
}

/**
 * An hour of shared cache is what a CDN keeps of either file, and what this process keeps of the
 * answer behind both. `prerender()` may enumerate rows that change, so the memo is never longer
 * than the response's own `max-age` — a crawler that bypasses the CDN sees what one behind it
 * would. Before it, every `/robots.txt` hit recomputed the whole sitemap, each dynamic route's
 * `prerender()` included.
 */
const SEO_CACHE = { mode: 'public', maxAgeSeconds: 3600 } as const;

/**
 * Origins remembered at once. With no declared origin the request's own is the key, and a `Host`
 * header is the caller's to choose — so the memo is bounded, oldest out first.
 */
const SEO_MEMO_ORIGINS = 8;

interface Memo {
  readonly at: number;
  readonly answer: Promise<SiteSeo>;
}

export function seoRoutes(options: SeoRoutesOptions): readonly Route[] {
  const environment: Environment =
    tryResolveEnvironment({ env: options.env }) ?? DEFAULT_ENVIRONMENT;
  const compute = (baseUrl: string): Promise<SiteSeo> =>
    siteSeo({
      baseUrl,
      environment,
      disallow: options.site?.disallow ?? [],
      ...(options.site === undefined ? {} : { sitemap: options.site.sitemap }),
      ...(options.root === undefined ? {} : { root: options.root }),
    });
  // Single-flight per origin: concurrent requests share the one computation in progress. A failed
  // one is dropped, so the next request asks again rather than serving the failure for an hour.
  const memo = new Map<string, Memo>();
  const answer = (request: UltimateRequest): Promise<SiteSeo> => {
    const origin = originOf(options, request);
    const now = Date.now();
    const kept = memo.get(origin);
    if (kept !== undefined && now - kept.at < SEO_CACHE.maxAgeSeconds * 1000) return kept.answer;
    memo.delete(origin);
    if (memo.size >= SEO_MEMO_ORIGINS) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    const computed = compute(origin);
    memo.set(origin, { at: now, answer: computed });
    // Voided: the request awaits `computed` itself and reports its failure; this branch only forgets it.
    void computed.catch(() => {
      if (memo.get(origin)?.answer === computed) memo.delete(origin);
    });
    return computed;
  };

  return [
    {
      method: 'GET',
      path: ROBOTS_PATH,
      meta: { name: 'seo.robots', auth: 'public', tags: ['seo'] },
      handler: async (request: UltimateRequest): Promise<Response> =>
        applyCacheHeaders(
          new Response((await answer(request)).robots, {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
          SEO_CACHE,
        ),
    },
    {
      method: 'GET',
      path: SITEMAP_PATH,
      meta: { name: 'seo.sitemap', auth: 'public', tags: ['seo'] },
      // The first file is `/sitemap.xml` in both shapes: the whole urlset, or the index of parts.
      handler: async (request: UltimateRequest): Promise<Response> =>
        applyCacheHeaders(
          new Response((await answer(request)).sitemaps[0]?.xml ?? '', {
            headers: { 'content-type': 'application/xml; charset=utf-8' },
          }),
          SEO_CACHE,
        ),
    },
    {
      method: 'GET',
      path: `${SITEMAP_PARTS_DIR}/:file`,
      meta: { name: 'seo.sitemapPart', auth: 'public', tags: ['seo'] },
      // A part of a split sitemap, from the same answer the index came from — so a part the index
      // names always exists here, and the static export writes the same paths.
      handler: async (request: UltimateRequest): Promise<Response> => {
        const seo = await answer(request);
        const part = seo.sitemaps.find((file) => file.path === request.pathname);
        if (part !== undefined && part.path !== SITEMAP_PATH) {
          return applyCacheHeaders(
            new Response(part.xml, {
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            }),
            SEO_CACHE,
          );
        }
        const index = new URL(SITEMAP_PATH, originOf(options, request)).href;
        const missing = jsonResponse(
          {
            ok: false,
            error: {
              code: 'X_ROUTE_NOT_FOUND',
              cause: `${request.pathname} is no part of this site's sitemap: the index names ${String(Math.max(seo.sitemaps.length - 1, 0))} part(s)`,
              fix: `curl -sS ${quoteArg(index)}`,
            },
          },
          { status: 404 },
        );
        // `no-store`: the part may exist once the site grows, and a cached miss would hide it.
        return applyCacheHeaders(missing, NO_STORE);
      },
    },
  ];
}
