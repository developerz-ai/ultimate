/**
 * `ssr` — per-request full render. The whole document waits for the slowest dependency,
 * which is exactly the trade you want for a fresh SEO page and exactly the trade you do
 * not want for an app page (use `stream`).
 */

import type { Ctx } from '@ultimat3/core';
import { cacheControl } from '@ultimat3/http';
import { finiteStatus } from './finite-status';
import type { RouteEntry } from './registry';
import type { RenderResult, RouteCache, RouteParams } from './route';

export interface SsrRenderInput {
  readonly entry: RouteEntry;
  readonly params: RouteParams;
  readonly url: URL;
  readonly ctx: Ctx;
}

export type SsrRenderFn = (input: SsrRenderInput) => string | Promise<string>;

export interface SsrOptions {
  readonly buildId: string;
  /** Extra `Vary` dimensions beyond the defaults. */
  readonly vary?: readonly string[];
  readonly status?: number;
}

export async function renderSsr(
  input: SsrRenderInput,
  render: SsrRenderFn,
  options: SsrOptions,
): Promise<RenderResult> {
  const html = await render(input);
  return {
    // Screened here and not at the Response boundary: `??` guards nullish, so a non-finite status
    // reaches `new Response` intact and raises a RangeError two frames above the route that set it.
    status: finiteStatus('renderSsr', options.status ?? 200),
    headers: ssrHeaders(input.entry, options),
    body: html,
  };
}

const PRIVATE_NO_STORE = 'private, no-store';

/**
 * The route's own `cache`, as a header. `no-store` in either spelling is `private, no-store`, the
 * gated page's answer: `private` is what `documentCarriesScope` reads, so a page the author just
 * made uncacheable carries its principal scope like every other private document. Everything else
 * is `@ultimat3/http`'s one emitter, never a second serializer.
 */
function declaredCacheControl(cache: RouteCache): string {
  if (cache === 'no-store' || cache.mode === 'no-store') return PRIVATE_NO_STORE;
  return cacheControl(cache);
}

/**
 * A gated page is never shared cache material: one actor's HTML in a CDN is the same bug
 * class as a cache key missing its tenant. A route's declared `cache` replaces the default —
 * `modes.ts` refuses a gated one that would widen it — and the pipeline's `cache-headers` stage
 * still reviews a `public` answer against the actor, so a signed-in visitor never gets one.
 */
export function ssrHeaders(
  entry: RouteEntry,
  options: SsrOptions,
): Readonly<Record<string, string>> {
  const gated = entry.config.policy !== undefined;
  const declared = entry.config.cache;
  const vary = new Set<string>(['accept-language', ...(options.vary ?? [])]);
  if (gated) vary.add('cookie');
  if (declared !== undefined && declared !== 'no-store') {
    for (const name of declared.vary ?? []) vary.add(name);
  }

  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control':
      declared !== undefined
        ? declaredCacheControl(declared)
        : gated
          ? PRIVATE_NO_STORE
          : 'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    vary: [...vary].sort().join(', '),
    'x-ultimate-build': options.buildId,
  };
}
