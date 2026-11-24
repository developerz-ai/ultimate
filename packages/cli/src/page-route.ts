// Single responsibility: a registered page's GET through the real `httpPipeline`, for a unit test —
// what a visitor RECEIVES (status, headers, cookies set, redirect, document), where `renderRoute`
// answers what the page renders. It lives in cli because the page handler (`appRoutes`) does.

import { assert } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

export interface PageRouteOptions {
  /** Request headers, as a browser sends them (`accept-language`, `if-none-match` …). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Cookies the request carries, by name; each value is percent-encoded as `useRequestCookie`
   * decodes it. Pass either this or a `cookie` header, never both.
   */
  readonly cookies?: Readonly<Record<string, string>>;
  /** The build the document names. Default `'page-route'`. */
  readonly buildId?: string;
}

const ORIGIN = 'http://localhost';

const cookieHeader = (cookies: Readonly<Record<string, string>>): string =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');

/**
 * `GET <path>` against the pages registered in this process (`registerRoute`, or `loadApp`), as the
 * response a visitor gets. `path` is the URL path and query (`/es/precios?page=2`), starting with
 * `/`. A path no page claims answers the pipeline's own 404.
 *
 * ```ts
 * const response = await pageRoute('/dashboard', { cookies: { sid: 's-1' } });
 * expect(response.status).toBe(200);
 * expect(response.headers.getSetCookie()).toEqual([]);
 * ```
 */
export async function pageRoute(path: string, options: PageRouteOptions = {}): Promise<Response> {
  assert(
    path.startsWith('/'),
    `pageRoute was handed '${path}', which is not a path`,
    "pageRoute('/dashboard?tab=2')   # the URL path and query, starting with '/'",
  );
  const headers = new Headers(options.headers);
  if (options.cookies !== undefined) {
    assert(
      !headers.has('cookie'),
      'pageRoute was handed both `cookies` and a `cookie` header',
      "pageRoute('/dashboard', { cookies: { sid: 's-1' } })   # the cookies once: as `cookies` or as a `cookie` header, not both",
    );
    if (Object.keys(options.cookies).length > 0) {
      headers.set('cookie', cookieHeader(options.cookies));
    }
  }
  const buildId = options.buildId ?? 'page-route';
  // One ISR controller per call, released after it: `appRoutes` would otherwise attach one it
  // never detaches, and every call of a suite would leave a revalidator behind.
  const { isr, release } = attachedIsr({ buildId });
  try {
    const pipeline = httpPipeline({
      table: httpRouter(appRoutes({ buildId, isr })),
      config: defineHttpConfig({
        dev: false,
        buildId,
        hostname: '127.0.0.1',
        rateLimit: { scope: 'process' },
      }),
    });
    return await pipeline.handle(new Request(`${ORIGIN}${path}`, { headers }), { role: 'web' });
  } finally {
    release();
  }
}
