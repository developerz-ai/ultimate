// `GET /robots.txt`, `GET /sitemap.xml` and its parts (`/sitemaps/<n>.xml`) from a running web
// role — the files the static export writes, for a deploy that serves its pages from a container.
// Mounted by `x dev` and `runRole` alike, before the app's pages, for `style-routes.ts`' reason.

import {
  DEFAULT_ENVIRONMENT,
  type Environment,
  finiteCount,
  logger,
  renderThrowable,
  tryResolveEnvironment,
} from '@ultimat3/core';
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
  /** The memo's clock, in ms. Injected so an hour's expiry is provable without waiting one out. */
  readonly now?: () => number;
  /** How long one enumeration may run, in ms. Injected so a hung one is provable in a test. */
  readonly enumerationTimeoutMs?: number;
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

/** How soon a failed re-enumeration is asked again while the previous answer keeps being served. */
const SEO_RETRY_MS = 60_000;

/** How long one enumeration may run before its origin stops waiting on it. */
const SEO_ENUMERATION_TIMEOUT_MS = 30_000;

/** Consecutive failed refreshes after which `seo.enumeration.kept` is logged as an error. */
const SEO_FAILURES_BEFORE_ERROR = 3;

interface Memo {
  at: number;
  answer: Promise<SiteSeo>;
  /** A refresh is running behind `answer`. */
  refreshing: boolean;
  /** The first enumeration has answered — only then is there something to refresh BEHIND. */
  settled: boolean;
  failures: number;
}

/** A placeholder for the one statement between building a first memo and starting its enumeration. */
const NO_ANSWER: SiteSeo = { robots: '', sitemaps: [] };

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
  // One answer per origin. A FIRST enumeration is single-flight and awaited; failed, it is dropped,
  // so the next request asks again rather than serving the failure for an hour.
  //
  // A LATER one — the hourly refresh — runs BEHIND the answer it would replace, and every request
  // meanwhile is served that answer: `prerender()` reads rows, and a database blip at the hour
  // mark otherwise answered a crawler a 500, while a read that HUNG held every sitemap request on
  // its pending promise. A failed or timed-out refresh keeps the last good sitemap and is asked
  // again a minute later. A `prerender()` that THROWS on a failed read is what makes this hold:
  // one that catches its own error and returns `[]` is a successful enumeration of nothing.
  const memo = new Map<string, Memo>();
  const clock = options.now ?? Date.now;
  const timeoutMs = finiteCount(
    'seoRoutes',
    'enumerationTimeoutMs',
    options.enumerationTimeoutMs ?? SEO_ENUMERATION_TIMEOUT_MS,
    1,
  );

  /** `compute`, settled at most once: with the answer, or `undefined` for a failure or a timeout. */
  const enumerate = (
    origin: string,
    settle: (answer: SiteSeo | undefined, why: string) => void,
  ) => {
    let settled = false;
    const once = (answer: SiteSeo | undefined, why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(answer, why);
    };
    const timer = setTimeout(() => {
      once(undefined, `no answer within ${String(timeoutMs)}ms`);
    }, timeoutMs);
    const computed = compute(origin);
    computed.then(
      (answer) => once(answer, ''),
      (error: unknown) => once(undefined, renderThrowable(error)),
    );
    return computed;
  };

  const refresh = (origin: string, kept: Memo): void => {
    kept.refreshing = true;
    void enumerate(origin, (answer, why) => {
      if (memo.get(origin) !== kept) return;
      if (answer !== undefined) {
        memo.set(origin, {
          at: clock(),
          answer: Promise.resolve(answer),
          refreshing: false,
          settled: true,
          failures: 0,
        });
        return;
      }
      kept.refreshing = false;
      kept.failures += 1;
      kept.at = clock() - SEO_CACHE.maxAgeSeconds * 1000 + SEO_RETRY_MS;
      // A blip is a warning; a sitemap that has not refreshed for several tries is going stale.
      const fields = { origin, failures: kept.failures, error: why };
      if (kept.failures >= SEO_FAILURES_BEFORE_ERROR) logger.error('seo.enumeration.kept', fields);
      else logger.warn('seo.enumeration.kept', fields);
    }).catch(() => undefined);
  };

  const answer = (request: UltimateRequest): Promise<SiteSeo> => {
    const origin = originOf(options, request);
    const kept = memo.get(origin);
    if (kept !== undefined) {
      const expired = clock() - kept.at >= SEO_CACHE.maxAgeSeconds * 1000;
      if (expired && !kept.refreshing && kept.settled) refresh(origin, kept);
      return kept.answer;
    }
    if (memo.size >= SEO_MEMO_ORIGINS) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    const first: Memo = {
      at: clock(),
      answer: Promise.resolve(NO_ANSWER),
      refreshing: false,
      settled: false,
      failures: 0,
    };
    // The request awaits the enumeration itself and reports its failure; a failed or hung one is
    // only forgotten here, so the next request starts its own rather than joining it.
    first.answer = enumerate(origin, (found) => {
      first.settled = true;
      if (found === undefined && memo.get(origin) === first) memo.delete(origin);
    });
    memo.set(origin, first);
    return first.answer;
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
