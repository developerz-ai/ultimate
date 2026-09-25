// `GET /robots.txt` and `GET /sitemap.xml` from a running web role — the files the static export
// writes, answered by the process for a deploy that serves its pages from a container. Mounted by
// `x dev` and `runRole` alike, before the app's pages, for `style-routes.ts`' reason.

import { DEFAULT_ENVIRONMENT, type Environment, tryResolveEnvironment } from '@ultimat3/core';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders } from '@ultimat3/http';
import { ROBOTS_PATH, SITEMAP_PATH, siteSeo } from './site-seo';

export interface SeoRoutesOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The public origin: `APP_URL`, the one the framework's runtime already names for it (OAuth's
 * redirect, the sync node's admitted origin); else `SITE_ORIGIN`, the static build's; else the
 * request's own. A container behind an ingress sees its pod address as the request's host, which
 * is why the declared origin comes first — a sitemap of `http://10.0.0.7:3000/…` indexes nothing.
 */
function originOf(env: SeoRoutesOptions['env'], request: UltimateRequest): string {
  for (const key of ['APP_URL', 'SITE_ORIGIN']) {
    const declared = env[key]?.trim() ?? '';
    if (declared !== '') return declared.replace(/\/+$/, '');
  }
  return new URL(request.url).origin;
}

/**
 * Per request, never cached across one: `prerender()` may enumerate rows that change, and a
 * crawler asks for these a handful of times a day. An hour of shared cache is what a CDN keeps.
 */
const SEO_CACHE = { mode: 'public', maxAgeSeconds: 3600 } as const;

export function seoRoutes(options: SeoRoutesOptions): readonly Route[] {
  const environment: Environment =
    tryResolveEnvironment({ env: options.env }) ?? DEFAULT_ENVIRONMENT;
  const answer = async (request: UltimateRequest) =>
    await siteSeo({ baseUrl: originOf(options.env, request), environment });

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
  ];
}
