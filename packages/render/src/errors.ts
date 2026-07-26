/**
 * Render's error codes. Every route failure is a stable code + cause + exact fix
 * (axiom 4), identical in the terminal, the browser overlay and `--json`.
 */

import { UltimateError } from '@ultimat3/core';

export const RENDER_ERROR_CODES = [
  'X_ROUTE_MODE_INVALID',
  'X_ROUTE_OFFLINE_MISSING',
  'X_ROUTE_META_MISSING',
  'X_ROUTE_DUPLICATE',
  'X_SURFACE_BOUNDARY',
  'X_BUDGET_EXCEEDED',
  'X_PRERENDER_FAILED',
] as const;

export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

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
