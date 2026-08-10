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
  'X_SURFACE_BOUNDARY',
  'X_BUDGET_EXCEEDED',
  'X_PRERENDER_FAILED',
] as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

export const RENDER_ERROR_TITLES: Readonly<Record<RenderErrorCode, string>> = {
  X_ROUTE_MODE_INVALID: 'render mode not allowed on this surface',
  X_ROUTE_OFFLINE_MISSING: "the route's offline strategy is missing or contradictory",
  X_ROUTE_META_MISSING: 'required metadata missing',
  X_ROUTE_UNNORMALIZED: 'a route was registered without defineRoute',
  X_ROUTE_DUPLICATE: 'two route files resolve to one URL',
  X_SURFACE_BOUNDARY: 'a surface imported across the hard boundary',
  X_BUDGET_EXCEEDED: 'a route blew its JS or LCP budget',
  X_PRERENDER_FAILED: 'a prerendered path threw during build',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(RENDER_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: RenderErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** A render mode's invariant was violated at registration (see `modes.ts`). */
export class RouteModeInvalidError extends UltimateError {
  static readonly code = 'X_ROUTE_MODE_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: RouteModeInvalidError.code,
      cause,
      fix,
      docs: docsFor(RouteModeInvalidError.code),
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
      docs: docsFor(RouteOfflineMissingError.code),
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
      docs: docsFor(RouteMetaMissingError.code),
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
      docs: docsFor(RouteUnnormalizedError.code),
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
      docs: docsFor(RouteDuplicateError.code),
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
      docs: docsFor(SurfaceBoundaryError.code),
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
      docs: docsFor(BudgetExceededError.code),
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
      docs: docsFor(PrerenderFailedError.code),
    });
  }
}
