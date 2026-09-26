/**
 * The four caching strategies as named functions, plus the render-mode → strategy table.
 * You never choose a strategy by hand: the mapping is derived and the override is the exception.
 * Every rule the worker routes is a DOCUMENT, and a document is network-first in every mode — the
 * cached copy is what offline gets, never what an online visitor gets (22.3.2).
 */

import type { OfflineStrategy, RenderMode } from '@ultimat3/core';
import { PwaStrategyExhaustedError } from './errors';

export type StrategyName =
  | 'cache-first'
  | 'network-first'
  | 'stale-while-revalidate'
  | 'network-only';

export const STRATEGY_NAMES: readonly StrategyName[] = [
  'cache-first',
  'network-first',
  'stale-while-revalidate',
  'network-only',
];

/**
 * Structural view of `@ultimat3/render`'s `RouteDescriptor`. Tier-4 packages must not
 * import each other, so route data arrives as data and this is the shape it must have.
 */
export interface PwaRoute {
  readonly path: string;
  readonly surface: 'site' | 'app' | 'api';
  readonly mode: RenderMode;
  readonly offline: OfflineStrategy;
  readonly dynamic?: boolean;
  /** Explicit per-route override; wins over the derived strategy. */
  readonly strategy?: StrategyName;
  /**
   * Content hash of the built HTML — the precache revision. Fed by the CLI's prerender pass; the
   * `buildId` is the fallback, and it re-downloads every precached page on every deploy.
   */
  readonly revision?: string;
  /** Byte size of the built HTML, from the same prerender pass. Counted against `warnBytes`. */
  readonly bytes?: number;
  /**
   * Companion data endpoint precached alongside the HTML. **Nothing in the framework's build path
   * sets it** — a hand-built `generateServiceWorker` call is the only route to a
   * `reason: 'route-data'` entry, so the branch in `precache.ts` is unreachable in production.
   * Kept because deleting a public field is a major; a candidate for the next one's
   * declared-and-never-wired sweep, with `ServiceWorkerConfig`'s shell trio.
   */
  readonly dataUrl?: string;
}

/**
 * Render mode → runtime strategy. The whole reason `sw.js` is generated, not written.
 *
 * Every row is `network-first`, `As of 22.3.2`, because every rule this table feeds is a
 * DOCUMENT: `routeRules` projects page routes only, and content-hashed chunks never get a rule —
 * they are `immutable` in the browser's HTTP cache. `static: 'cache-first'` and
 * `isr`/`stream: 'stale-while-revalidate'` answered an ONLINE navigation from the copy the old
 * worker held, and that copy is the old HTML naming the old hashed CSS and islands, so a visitor saw
 * a deploy only after Shift+F5 (measured on notificado.co, 22.3.1). A precached or pages-cached
 * document is the OFFLINE answer, which `networkFirst` already is on a failed fetch; the render
 * mode still decides WHERE that copy lives (`cacheFor`: precache or pages), not whether it is
 * served while the network answers. A per-route `strategy` is still the override.
 *
 * Two separate things make the closed set hold, and the table needed both. `Record<RenderMode, …>`
 * over the TIER-0 union is the exhaustiveness check — this was keyed on a hand-copy, which is how
 * `spa` went on mapping to `cache-first` after `spa` was deleted from the vocabulary: the one
 * strategy that gives an `app/` route a SHARED cache entry, i.e. one member's authed HTML served
 * to the next. And `Object.freeze<T>({…})` with an EXPLICIT type argument, never
 * `const X: T = Object.freeze({…})` — the second form infers `T` from the literal and the
 * annotation only checks assignability afterwards, so the literal's freshness is already gone and
 * an EXTRA key compiles in silence. Named, the literal is contextually typed and a missing key
 * AND an extra key are both build errors.
 */
export const MODE_STRATEGY = Object.freeze<Record<RenderMode, StrategyName>>({
  static: 'network-first',
  isr: 'network-first',
  ssr: 'network-first',
  stream: 'network-first',
});

export function strategyFor(route: PwaRoute): StrategyName {
  if (route.strategy !== undefined) return route.strategy;
  // `network-only` is a declaration that this URL must never be answered from a cache.
  if (route.offline === 'network-only') return 'network-only';
  return MODE_STRATEGY[route.mode];
}

export interface StrategyEnv {
  /** The named cache this strategy reads and writes. */
  open(cacheName: string): Promise<StrategyCache>;
  fetch(request: Request): Promise<Response>;
  /** The fetch event's `waitUntil`, when there is one — background work must be handed to it. */
  wait?(work: Promise<unknown>): void;
}

export interface StrategyCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface StrategyOptions {
  readonly cacheName: string;
  /** Served when the network fails and the cache is empty. */
  readonly fallback?: () => Promise<Response>;
}

export async function cacheFirst(
  request: Request,
  env: StrategyEnv,
  options: StrategyOptions,
): Promise<Response> {
  const cache = await env.open(options.cacheName);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;
  return fetchAndStore(request, env, cache, options);
}

export async function networkFirst(
  request: Request,
  env: StrategyEnv,
  options: StrategyOptions,
): Promise<Response> {
  const cache = await env.open(options.cacheName);
  try {
    const response = await env.fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit !== undefined) return hit;
    if (options.fallback !== undefined) return options.fallback();
    throw error;
  }
}

/** Answer from the cache immediately, refresh behind the response. */
export async function staleWhileRevalidate(
  request: Request,
  env: StrategyEnv,
  options: StrategyOptions,
): Promise<Response> {
  const cache = await env.open(options.cacheName);
  const hit = await cache.match(request);
  const refresh = env
    .fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(async () => (hit !== undefined ? hit : fallbackOrThrow(options)));

  if (hit !== undefined) {
    // The refresh is handed to the event's `waitUntil` NOW, before the cached answer returns:
    // taken after `respondWith` settled, a browser refuses the extension (`InvalidStateError`) and
    // may kill the worker mid-refresh. `later` also swallows its rejection, as `.catch` did.
    env.wait?.(refresh.catch(() => undefined));
    return hit;
  }
  return refresh;
}

export async function networkOnly(
  request: Request,
  env: StrategyEnv,
  options: StrategyOptions,
): Promise<Response> {
  try {
    return await env.fetch(request);
  } catch (error) {
    if (options.fallback !== undefined) return options.fallback();
    throw error;
  }
}

export const STRATEGY_FNS = Object.freeze<
  Record<
    StrategyName,
    (request: Request, env: StrategyEnv, options: StrategyOptions) => Promise<Response>
  >
>({
  'cache-first': cacheFirst,
  'network-first': networkFirst,
  'stale-while-revalidate': staleWhileRevalidate,
  'network-only': networkOnly,
});

async function fetchAndStore(
  request: Request,
  env: StrategyEnv,
  cache: StrategyCache,
  options: StrategyOptions,
): Promise<Response> {
  try {
    const response = await env.fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (options.fallback !== undefined) return options.fallback();
    throw error;
  }
}

async function fallbackOrThrow(options: StrategyOptions): Promise<Response> {
  if (options.fallback !== undefined) return options.fallback();
  throw new PwaStrategyExhaustedError({ cacheName: options.cacheName });
}

/**
 * The emitted counterpart of the functions above. Kept as source strings because the
 * service worker is a generated artifact with no bundler in the loop — the shapes are
 * identical on purpose and `strategies.test.ts` asserts both halves stay in step. They open a
 * cache through the worker's `openCache`, never `caches.open`: the pages cache is a facade that
 * partitions a per-member document by principal (`service-worker.ts`, `pagesCache`). And the cache
 * copy is NEVER awaited before answering: `Cache.put` reads the whole body, so awaiting it held a
 * streamed document away from the tab until it had ended. It goes to `later(wait, …)` instead —
 * the fetch event's `waitUntil`, which keeps the worker alive for the copy.
 */
export const STRATEGY_SOURCE = Object.freeze<Record<StrategyName, string>>({
  'cache-first': `async function cacheFirst(req,cn,fb,wait){
  const c=await openCache(cn);const hit=await c.match(req);if(hit)return hit;
  try{const r=await fetch(req);if(r.ok)later(wait,c.put(req,r.clone()));return r}catch(e){if(fb)return fb();throw e}
}`,
  'network-first': `async function networkFirst(req,cn,fb,wait){
  const c=await openCache(cn);
  try{const r=await fetch(req);if(r.ok)later(wait,c.put(req,r.clone()));return r}
  catch(e){const hit=await c.match(req);if(hit)return hit;if(fb)return fb();throw e}
}`,
  'stale-while-revalidate': `async function staleWhileRevalidate(req,cn,fb,wait){
  const c=await openCache(cn);const hit=await c.match(req);
  const refresh=fetch(req).then((r)=>{if(r.ok)later(wait,c.put(req,r.clone()));return r})
    .catch(()=>hit||(fb?fb():Response.error()));
  if(hit){later(wait,refresh);return hit}
  return refresh
}`,
  'network-only': `async function networkOnly(req,cn,fb,wait){
  try{return await fetch(req)}catch(e){if(fb)return fb();throw e}
}`,
});

export const STRATEGY_FN_NAMES = Object.freeze<Record<StrategyName, string>>({
  'cache-first': 'cacheFirst',
  'network-first': 'networkFirst',
  'stale-while-revalidate': 'staleWhileRevalidate',
  'network-only': 'networkOnly',
});
