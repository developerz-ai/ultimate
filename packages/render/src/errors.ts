/**
 * Render's error codes. Every route failure is a stable code + cause + exact fix
 * (axiom 4), identical in the terminal, the browser overlay and `--json`.
 */

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const RENDER_ERROR_CODES = [
  'X_ROUTE_MODE_INVALID',
  'X_ROUTE_OFFLINE_MISSING',
  'X_ROUTE_META_MISSING',
  'X_ROUTE_UNNORMALIZED',
  'X_ROUTE_DUPLICATE',
  'X_ROUTE_FILE_INVALID',
  'X_ROUTE_LOAD_INVALID',
  'X_ROUTE_LOAD_FAILED',
  'X_SURFACE_BOUNDARY',
  'X_BUDGET_EXCEEDED',
  'X_PRERENDER_FAILED',
  'X_ISLAND_INVALID',
  'X_ISLAND_PROPS_INVALID',
  'X_ISLAND_NOT_HYDRATED',
  // Render's, not the CLI's, for the same reason X_BUDGET_EXCEEDED is: this package owns the
  // stylesheet registry and `stylesFor`, so "the CSS a document on this surface carries" is a fact
  // about render's own output. `x verify` is only the surface that reports it.
  'X_STYLES_GLOBAL_MISSING',
] as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

export const RENDER_ERROR_TITLES: Readonly<Record<RenderErrorCode, string>> = {
  X_ROUTE_MODE_INVALID: 'render mode not allowed on this surface',
  X_ROUTE_OFFLINE_MISSING: "the route's offline strategy is missing or contradictory",
  X_ROUTE_META_MISSING: 'required metadata missing',
  X_ROUTE_UNNORMALIZED: 'a route was registered without defineRoute',
  X_ROUTE_DUPLICATE: 'two route files resolve to one URL',
  X_ROUTE_FILE_INVALID: 'a route file is not named for its surface',
  X_ROUTE_LOAD_INVALID: 'a route declared a load that is not a function',
  X_ROUTE_LOAD_FAILED: "a route's load threw while resolving its data",
  X_SURFACE_BOUNDARY: 'a surface imported across the hard boundary',
  X_BUDGET_EXCEEDED: 'a route blew its JS or LCP budget',
  X_PRERENDER_FAILED: 'a prerendered path threw during build',
  X_ISLAND_INVALID: 'an island declaration cannot become a client entry',
  X_ISLAND_PROPS_INVALID: 'an island was passed props it cannot carry to the browser',
  X_ISLAND_NOT_HYDRATED: 'a page renders an island that nothing would ever boot',
  X_STYLES_GLOBAL_MISSING:
    'a surface renders documents whose CSS defines no :root custom properties',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(RENDER_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

/** A render mode's invariant was violated at registration (see `modes.ts`). */
export class RouteModeInvalidError extends UltimateError {
  static readonly code = 'X_ROUTE_MODE_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteModeInvalidError.code,
      cause,
      fix,
    });
  }
}

/** `offline` is required by the type; this catches JS callers that bypass it. */
export class RouteOfflineMissingError extends UltimateError {
  static readonly code = 'X_ROUTE_OFFLINE_MISSING' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteOfflineMissingError.code,
      cause,
      fix,
    });
  }
}

/** `meta` is required by the type; this catches JS callers that bypass it. */
export class RouteMetaMissingError extends UltimateError {
  static readonly code = 'X_ROUTE_META_MISSING' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteMetaMissingError.code,
      cause,
      fix,
    });
  }
}

/**
 * The route table holds descriptors, never declarations. `defineRoute` is the one normalizer, so
 * a raw declaration reaching the registry means `budget` and `meta` are whatever the author wrote
 * — and every reader downstream (`describeRoutes`, `sw.js`, the sitemap) assumes they are not.
 */
export class RouteUnnormalizedError extends UltimateError {
  static readonly code = 'X_ROUTE_UNNORMALIZED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteUnnormalizedError.code,
      cause,
      fix,
    });
  }
}

/** Two files claim the same URL — the route table must stay a function of the path. */
export class RouteDuplicateError extends UltimateError {
  static readonly code = 'X_ROUTE_DUPLICATE' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteDuplicateError.code,
      cause,
      fix,
    });
  }
}

/**
 * A route file is not named for its surface. One spelling per surface — `page.tsx` under `site/`
 * and `app/`, `route.ts` under `api/` — because the URL is the *directory* path, and a second
 * spelling makes "is this file a route?" undecidable for every reader that has to answer it:
 * the module scan, the boundary walk, `sw.js`, and the author looking at the folder.
 */
export class RouteFileInvalidError extends UltimateError {
  static readonly code = 'X_ROUTE_FILE_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteFileInvalidError.code,
      cause,
      fix,
    });
  }
}

/** A surface imported across the hard boundary (`site/` → `app/`, `shared/` → anything). */
export class SurfaceBoundaryError extends UltimateError {
  static readonly code = 'X_SURFACE_BOUNDARY' as const;
  constructor(cause: string, fix: string) {
    super({
      code: SurfaceBoundaryError.code,
      cause,
      fix,
    });
  }
}

/** A route's measured JS/LCP exceeded its declared `budget`. */
export class BudgetExceededError extends UltimateError {
  static readonly code = 'X_BUDGET_EXCEEDED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: BudgetExceededError.code,
      cause,
      fix,
    });
  }
}

/** `prerender()` threw, returned a non-enumeration, or produced unusable params. */
export class PrerenderFailedError extends UltimateError {
  static readonly code = 'X_PRERENDER_FAILED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PrerenderFailedError.code,
      cause,
      fix,
    });
  }
}

/** `load` is optional, so this catches a value that is present and not callable. */
export class RouteLoadInvalidError extends UltimateError {
  static readonly code = 'X_ROUTE_LOAD_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteLoadInvalidError.code,
      cause,
      fix,
    });
  }
}

/**
 * The declaration itself cannot become a client entry: no `src`, a remote URL, a name that is not
 * `*.island.tsx`, or two islands on one page claiming one id. Thrown where `island()` is written,
 * so the failure lands in the file the author is editing.
 */
export class IslandInvalidError extends UltimateError {
  static readonly code = 'X_ISLAND_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: IslandInvalidError.code,
      cause,
      fix,
    });
  }
}

/**
 * An island is named by specifier, so it can close over nothing — its props are the only channel
 * from the server, and this is what keeps that channel to declared, JSON-safe, budgeted values.
 * The failure it exists for is `<Modal {...row} />`: a spread that ships a column nobody meant to.
 */
export class IslandPropsInvalidError extends UltimateError {
  static readonly code = 'X_ISLAND_PROPS_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: IslandPropsInvalidError.code,
      cause,
      fix,
    });
  }
}

/**
 * The page renders an island nothing would boot: the route says `hydrate: 'never'`, or the render
 * collected no islands so no runtime is emitted. Both ship inert markup — and `hydrate: 'never'`
 * is exactly what excuses a `site/` route from declaring `budget.js`, so silence here is how the
 * budget stops meaning anything.
 */
export class IslandNotHydratedError extends UltimateError {
  static readonly code = 'X_ISLAND_NOT_HYDRATED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: IslandNotHydratedError.code,
      cause,
      fix,
    });
  }
}

/**
 * A loader threw. Named separately from whatever it threw because the useful fact is WHICH route
 * failed to load — a bare rejection surfaces the repo's own stack and not the URL an author has
 * to go and fix.
 */
export class RouteLoadFailedError extends UltimateError {
  static readonly code = 'X_ROUTE_LOAD_FAILED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteLoadFailedError.code,
      cause,
      fix,
    });
  }
}
