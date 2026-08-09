/**
 * The `route` primitive. `defineRoute` is the only way to declare a URL's render mode,
 * offline strategy, hydration timing and metadata, and it hands back a descriptor that is
 * already normalized: `meta` always awaits, `budget` is always there.
 *
 * `offline`, `hydrate` and `meta` are REQUIRED BY THE TYPE. That is axiom 3 — enforced,
 * not documented — expressed in the type system: a route that forgets its offline
 * strategy or its `<head>` is a compile error, not a checklist item nobody reads.
 */

import type { CacheTag } from '@ultimat3/cache';
import { serializeTags } from '@ultimat3/cache';
import type { RouteMeta } from '@ultimat3/seo';
import { RouteMetaMissingError, RouteOfflineMissingError } from './errors';
import { assertModeShape } from './modes';

export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';
export type OfflineStrategy = 'precache' | 'runtime' | 'network-only';
export type HydrateStrategy = 'idle' | 'visible' | 'interaction' | 'never';

export const OFFLINE_STRATEGIES = ['precache', 'runtime', 'network-only'] as const;
export const HYDRATE_STRATEGIES = ['idle', 'visible', 'interaction', 'never'] as const;

export type RouteParams = Readonly<Record<string, string>>;
export type RouteData = Readonly<Record<string, unknown>>;

/** ISR trigger. At least one of `tags` / `ttl` is required by `modes.ts`. */
export interface RevalidateConfig {
  readonly tags?: readonly CacheTag[];
  /** `'5m'`, `'1h'`, `'7d'` or milliseconds. */
  readonly ttl?: string | number;
}

export interface RouteBudget {
  /** `'40kb'` — measured from the real bundle graph, not the source size. */
  readonly js?: string;
  readonly css?: string;
  /** Milliseconds, median of N headless runs. */
  readonly lcp?: number;
  readonly cls?: number;
  readonly tbt?: number;
}

/**
 * Structural view of a `@ultimat3/policy` guard. Render only needs to know a route HAS
 * one (the `spa` invariant) — evaluation stays in policy, so there is exactly one authz
 * system and render cannot grow a second door.
 */
export interface RouteGuard {
  readonly permission: string;
}

/** What an author writes. Sync or async, whichever the page's data needs. */
export type RouteMetaFn<TData = RouteData> = (data: TData) => RouteMeta | Promise<RouteMeta>;

/** What the descriptor hands back. One shape, so no consumer branches on a thenable. */
export type RouteMetaAsyncFn<TData = RouteData> = (data: TData) => Promise<RouteMeta>;

/** Returns the params to build at deploy time. Bare strings fill a single dynamic param. */
export type PrerenderFn = () =>
  | readonly (string | RouteParams)[]
  | Promise<readonly (string | RouteParams)[]>;

/** The input shape of `defineRoute` — exactly the contract's eight keys, nothing else. */
export interface RouteDefinition<TData = RouteData> {
  readonly render: RenderMode;
  readonly revalidate?: RevalidateConfig;
  readonly prerender?: PrerenderFn;
  readonly offline: OfflineStrategy;
  readonly hydrate: HydrateStrategy;
  readonly budget?: RouteBudget;
  readonly meta: RouteMetaFn<TData>;
  readonly policy?: RouteGuard;
}

/**
 * The frozen descriptor. `kind` lets the registry reject non-route exports.
 *
 * Two fields are narrower here than in the declaration so every consumer reads one shape:
 * `meta` always returns a promise, and `budget` is always an object. Its *fields* stay
 * optional — `budget.js === undefined` still means "this route declared no JS budget",
 * which is exactly what `modes.ts` fails a hydrating `site/` route on.
 */
export interface RouteConfig<TData = RouteData> extends RouteDefinition<TData> {
  readonly kind: 'route';
  readonly meta: RouteMetaAsyncFn<TData>;
  readonly budget: RouteBudget;
}

/** What every render mode hands back to `@ultimat3/http`'s `html()` / `stream()`. */
export interface RenderResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | ReadableStream<Uint8Array>;
}

/**
 * Route descriptors carry tags in `@ultimat3/cache`'s wire form (`post`, `post:123`), the
 * same strings every cache tier speaks. Render never invents a key convention of its own.
 */
export function tagKeys(tags: readonly CacheTag[] | undefined): readonly string[] {
  return tags === undefined ? [] : serializeTags(tags);
}

/**
 * Declare a route. Validates the shape (for JS callers who bypass the types) and the
 * mode-local invariants immediately, so a bad route fails at module evaluation — build
 * time — rather than on the first request in production.
 */
export function defineRoute<TData = RouteData>(
  definition: RouteDefinition<TData>,
): RouteConfig<TData> {
  const def = definition as Partial<RouteDefinition<TData>>;

  if (def.offline === undefined) {
    throw new RouteOfflineMissingError(
      'defineRoute() called without an `offline` strategy',
      "add offline: 'precache' | 'runtime' | 'network-only' to defineRoute",
    );
  }
  if (!OFFLINE_STRATEGIES.includes(def.offline)) {
    throw new RouteOfflineMissingError(
      `offline: ${JSON.stringify(def.offline)} is not a known strategy`,
      `use one of ${OFFLINE_STRATEGIES.join(' | ')}`,
    );
  }
  if (typeof def.meta !== 'function') {
    throw new RouteMetaMissingError(
      'defineRoute() called without a `meta` function',
      'add meta: () => ({ title, description }) to defineRoute',
    );
  }

  const declaredMeta = def.meta;
  const config: RouteConfig<TData> = {
    kind: 'route',
    render: def.render as RenderMode,
    offline: def.offline,
    hydrate: def.hydrate as HydrateStrategy,
    // Wrapped rather than stored: the declaration may be sync, the descriptor never is.
    // A meta that throws synchronously becomes a rejection here, so `await config.meta(d)`
    // is the one way to fail as well as the one way to succeed.
    meta: async (data: TData) => declaredMeta(data),
    // Always an object. `budget.js` is the only reach a consumer needs, so an undeclared
    // budget is `{}` instead of a second undefined-check at every call site.
    budget: def.budget ?? {},
    ...(def.revalidate ? { revalidate: def.revalidate } : {}),
    ...(def.prerender ? { prerender: def.prerender } : {}),
    ...(def.policy ? { policy: def.policy } : {}),
  };

  assertModeShape(config);
  return Object.freeze(config);
}

export function isRouteConfig(value: unknown): value is RouteConfig {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'route';
}
