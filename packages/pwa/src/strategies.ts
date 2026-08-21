/**
 * The four caching strategies as named functions, plus the render-mode → strategy table.
 * You never choose a strategy by hand: the route's render mode already encodes how fresh
 * its bytes have to be, so the mapping is derived and the override is the exception.
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
  /** Content hash of the built HTML — the precache revision. */
  readonly revision?: string;
  readonly bytes?: number;
  /** Companion data endpoint precached alongside the HTML. */
  readonly dataUrl?: string;
}

/**
 * Render mode → runtime strategy. The whole reason `sw.js` is generated, not written.
 *
 * `Record<RenderMode, …>` over the tier-0 union is the exhaustiveness check: a mode with no row is
 * a compile error, and a row for a mode that does not exist is a compile error too. That second
 * half is the one that mattered — `spa` kept mapping to `cache-first` here after it was deleted
 * from the vocabulary, the one strategy that gives an `app/` route a SHARED cache entry, i.e. one
 * member's authed HTML served to the next. It compiled because this Record was keyed on a copy.
 */
/**
 * `Object.freeze<T>({…})` with an EXPLICIT type argument, never `const X: T = Object.freeze({…})`.
 * The second form loses the object literal's freshness — the literal is inferred first and the
 * annotation only checks assignability afterwards — so an EXTRA key compiles silently. That is not
 * a hypothetical: `spa: 'cache-first'` sat in `@ultimat3/pwa`'s copy of this table after `spa` was
 * deleted from the vocabulary, and `tsc` had nothing to say. Naming the type argument makes the
 * literal contextually typed, so a missing key AND an extra key are both build errors.
 */
export const MODE_STRATEGY = Object.freeze<Record<RenderMode, StrategyName>>({
  static: 'cache-first',
  isr: 'stale-while-revalidate',
  ssr: 'network-first',
  stream: 'stale-while-revalidate',
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
    void refresh.catch(() => undefined);
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
 * identical on purpose and `strategies.test.ts` asserts both halves stay in step.
 */
export const STRATEGY_SOURCE = Object.freeze<Record<StrategyName, string>>({
  'cache-first': `async function cacheFirst(req,cn,fb){
  const c=await caches.open(cn);const hit=await c.match(req);if(hit)return hit;
  try{const r=await fetch(req);if(r.ok)await c.put(req,r.clone());return r}catch(e){if(fb)return fb();throw e}
}`,
  'network-first': `async function networkFirst(req,cn,fb){
  const c=await caches.open(cn);
  try{const r=await fetch(req);if(r.ok)await c.put(req,r.clone());return r}
  catch(e){const hit=await c.match(req);if(hit)return hit;if(fb)return fb();throw e}
}`,
  'stale-while-revalidate': `async function staleWhileRevalidate(req,cn,fb){
  const c=await caches.open(cn);const hit=await c.match(req);
  const refresh=fetch(req).then(async(r)=>{if(r.ok)await c.put(req,r.clone());return r})
    .catch(()=>hit||(fb?fb():Response.error()));
  if(hit){refresh.catch(()=>{});return hit}
  return refresh
}`,
  'network-only': `async function networkOnly(req,cn,fb){
  try{return await fetch(req)}catch(e){if(fb)return fb();throw e}
}`,
});

export const STRATEGY_FN_NAMES = Object.freeze<Record<StrategyName, string>>({
  'cache-first': 'cacheFirst',
  'network-first': 'networkFirst',
  'stale-while-revalidate': 'staleWhileRevalidate',
  'network-only': 'networkOnly',
});
