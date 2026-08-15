/**
 * The `route` primitive. `defineRoute` is the only way to declare a URL's render mode,
 * offline strategy, hydration timing and metadata, and it hands back a descriptor that is
 * already normalized: `meta` always awaits, `budget` is always there.
 *
 * `offline` and `meta` are REQUIRED BY THE TYPE. That is axiom 3 — enforced, not documented —
 * expressed in the type system: a route that forgets its offline strategy or its `<head>` is a
 * compile error, not a checklist item nobody reads.
 *
 * `hydrate` is not on that list, since 1.2.0: it is the one key the framework can work out from
 * the page's own declarations, and requiring a value it already knows is not enforcement, it is a
 * second place to get one thing wrong.
 */

import type { CacheTag } from '@ultimat3/cache';
import { serializeTags } from '@ultimat3/cache';
import type { Translator } from '@ultimat3/i18n';
import type { RouteMeta } from '@ultimat3/seo';
import { RouteLoadInvalidError, RouteMetaMissingError, RouteOfflineMissingError } from './errors';
import type { IslandSpec } from './island';
import { drainDeclaredIslands } from './island';
import { assertModeShape } from './modes';

export type RenderMode = 'static' | 'isr' | 'ssr' | 'stream' | 'spa';
export type OfflineStrategy = 'precache' | 'runtime' | 'network-only';
export type HydrateStrategy = 'idle' | 'visible' | 'interaction' | 'never';

export const OFFLINE_STRATEGIES = ['precache', 'runtime', 'network-only'] as const;
export const HYDRATE_STRATEGIES = ['idle', 'visible', 'interaction', 'never'] as const;

/**
 * What a page that declares an island hydrates as when it says nothing. The most conservative of
 * the three that ship JavaScript: nothing runs until the visitor acts, and `interaction` is the
 * only one that also replays the event that woke the island, so the first click is answered rather
 * than swallowed. An island wanting `visible` (an infinite scroll) still says so once — on the
 * route, the same key that overrides this one, never a second declaration on the island itself.
 */
export const DEFAULT_ISLAND_HYDRATE: HydrateStrategy = 'interaction';

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

/**
 * What a loader and a `meta` function are told about the request. `url` is a string because that
 * is what `ld.*` embeds and what `meta` already received before `load` existed.
 *
 * An alias rather than an `interface`, deliberately: absent a `load` this object IS the route's
 * data, and only an alias carries the implicit index signature that makes it a `RouteData`. As an
 * interface the compiler could not see that, so the one place it mattered — `routeDataFor`'s
 * fallback — laundered it through `as unknown as TData` and checked nothing at all.
 */
export type RouteContext = {
  readonly params: RouteParams;
  readonly url: string;
};

/**
 * The route's server-side data, resolved ONCE per render and handed to both `meta` and the page.
 *
 * This is not a ninth concern bolted onto the contract — it completes the one `meta` already
 * declares. `RouteMetaFn<TData>` has always taken a `TData`, and until this existed nothing could
 * ever supply one richer than `{ url, params }`: the page component was passed the same two
 * fields, so a page that fetched its own data could not share it with `meta`. The consequence was
 * silent and severe — a `site/` route's `<title>` and `description` could never reflect its
 * content, on the surface whose entire purpose is SEO, and a page written against `props.data`
 * rendered an empty list with a 200 rather than an error.
 *
 * Sync or async, whichever the page's data needs.
 */
export type RouteLoadFn<TData = RouteData> = (ctx: RouteContext) => TData | Promise<TData>;

/** What the descriptor hands back. One shape, so no consumer branches on a thenable. */
export type RouteLoadAsyncFn<TData = RouteData> = (ctx: RouteContext) => Promise<TData>;

/**
 * What `meta` is given: the loaded data, the request, and the translator.
 *
 * A context rather than the bare data, because a `<title>` needs all three — the data for the
 * content, `url` for the canonical, and `t` because no user-facing string may be hardcoded. It is
 * a strict SUPERSET of what `meta` received before `load` existed (`{ params, url }`), and both
 * keys keep their names, so every route that reads `data.url` or `data.params` keeps working.
 */
export interface RouteMetaContext<TData = RouteData> {
  readonly data: TData;
  readonly params: RouteParams;
  readonly url: string;
  /** The request's own translator. Never a hardcoded string in a `<title>`. */
  readonly t: Translator;
}

/** What an author writes. Sync or async, whichever the page's data needs. */
export type RouteMetaFn<TData = RouteData> = (
  ctx: RouteMetaContext<TData>,
) => RouteMeta | Promise<RouteMeta>;

/** What the descriptor hands back. One shape, so no consumer branches on a thenable. */
export type RouteMetaAsyncFn<TData = RouteData> = (
  ctx: RouteMetaContext<TData>,
) => Promise<RouteMeta>;

/** Returns the params to build at deploy time. Bare strings fill a single dynamic param. */
export type PrerenderFn = () =>
  | readonly (string | RouteParams)[]
  | Promise<readonly (string | RouteParams)[]>;

/**
 * The rule that makes the no-`load` fallback true: a route that loads nothing renders
 * `{ params, url }`, so its `meta` may only read what the context itself supplies. Any richer
 * `TData` has to come from a loader, and this intersection is what says so — `nothing` when the
 * context already satisfies `TData`, a required `load` when it does not.
 *
 * Enforced, not documented (axiom 3): a `meta` reading `data.post` off a route that declares no
 * `load` is a compile error here, rather than `undefined` in a `<title>` on the surface whose
 * entire purpose is SEO.
 */
export type LoadRequirement<TData> = RouteContext extends TData
  ? unknown
  : { readonly load: RouteLoadFn<TData> };

/** The input shape of `defineRoute` — exactly the contract's nine keys, nothing else. */
export interface RouteDefinition<TData = RouteData> {
  readonly render: RenderMode;
  readonly revalidate?: RevalidateConfig;
  readonly prerender?: PrerenderFn;
  readonly offline: OfflineStrategy;
  /**
   * Optional since 1.2.0, and derived when omitted: a page that declares an island hydrates
   * (`DEFAULT_ISLAND_HYDRATE`), a page that declares none ships nothing (`'never'`). Stating it is
   * still the one override, and still the only way to say `visible` or `idle`.
   *
   * It was required, and the two failures that made it worth deriving were both the framework
   * asking for a value it could already work out: an island on a route still at `'never'` is
   * `X_ISLAND_NOT_HYDRATED`, and a `site/` route off `'never'` with no `budget.js` is refused at
   * registration. Two punishments for one omission the declaration above already answered.
   */
  readonly hydrate?: HydrateStrategy;
  readonly budget?: RouteBudget;
  readonly load?: RouteLoadFn<TData>;
  readonly meta: RouteMetaFn<TData>;
  readonly policy?: RouteGuard;
}

/**
 * The frozen descriptor. `kind` lets the registry reject non-route exports.
 *
 * Three fields are narrower here than in the declaration so every consumer reads one shape:
 * `meta` always returns a promise, `budget` is always an object, and `hydrate` is always one of
 * the four strategies — resolved, so nothing downstream repeats the derivation. `budget`'s
 * *fields* stay optional; `budget.js === undefined` still means "no JS budget declared", which is
 * what `registry.ts` fills in for an island route and `modes.ts` fails a hydrating `site/` route on.
 */
export interface RouteConfig<TData = RouteData> extends RouteDefinition<TData> {
  readonly kind: 'route';
  readonly meta: RouteMetaAsyncFn<TData>;
  readonly load?: RouteLoadAsyncFn<TData>;
  readonly hydrate: HydrateStrategy;
  readonly budget: RouteBudget;
  /**
   * The islands this module declared, in declaration order. Never written by an author — drained
   * from `island()`, and the reason `hydrate` and `budget.js` do not have to be. Also what finally
   * populates `RouteEntry.islands`, which `routeJsBytes` has always read and nothing ever filled.
   */
  readonly islands: readonly IslandSpec[];
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
 *
 * `LoadRequirement` is the half the compiler owns: a `meta` reading data the context cannot
 * supply forces a `load`, which is what lets `routeDataFor` hand the context back as the data.
 */
export function defineRoute<TData = RouteData>(
  definition: RouteDefinition<TData> & LoadRequirement<TData>,
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

  if (def.load !== undefined && typeof def.load !== 'function') {
    throw new RouteLoadInvalidError(
      `load: ${JSON.stringify(def.load)} is not a function`,
      'make load a function of ({ params, url }) returning the page data, or remove it',
    );
  }

  const declaredMeta = def.meta;
  const declaredLoad = def.load;
  // Drained unconditionally, even when `hydrate` is stated: the list must not survive into the
  // next route defined in this process, and `RouteEntry.islands` wants it either way.
  const islands = drainDeclaredIslands();
  const config: RouteConfig<TData> = {
    kind: 'route',
    render: def.render as RenderMode,
    offline: def.offline,
    islands,
    // Declared wins, always — including `hydrate: 'never'` on a page that has an island, which is
    // a contradiction an author stated on purpose and `X_ISLAND_NOT_HYDRATED` still refuses.
    hydrate: def.hydrate ?? (islands.length > 0 ? DEFAULT_ISLAND_HYDRATE : 'never'),
    // Wrapped rather than stored: the declaration may be sync, the descriptor never is.
    // A meta that throws synchronously becomes a rejection here, so `await config.meta(d)`
    // is the one way to fail as well as the one way to succeed.
    meta: async (metaCtx: RouteMetaContext<TData>) => declaredMeta(metaCtx),
    // Always an object. `budget.js` is the only reach a consumer needs, so an undeclared
    // budget is `{}` instead of a second undefined-check at every call site.
    budget: def.budget ?? {},
    // Wrapped exactly as `meta` is, and for the same reason: the declaration may be sync, the
    // descriptor never is, so `await config.load(ctx)` is the one way to fail as well as succeed.
    ...(declaredLoad ? { load: async (ctx: RouteContext) => declaredLoad(ctx) } : {}),
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
