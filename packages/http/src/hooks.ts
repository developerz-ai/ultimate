// The two seams the HTTP layer cannot own itself: who the actor is (auth lives in
// `@ultimat3/auth`, tier 3) and whether a policy allows the call (`@ultimat3/policy`
// is a sibling tier, so it cannot be imported here). Both are declared structurally,
// which keeps the import boundary intact and keeps the pipeline testable.
import type { Actor } from '@ultimat3/core';
import type { RequestContext } from './context';
import type { UltimateRequest } from './request';
import type { Route } from './router';

/**
 * Structurally identical to `PolicyDecision` in `@ultimat3/policy`. Tier 3 passes
 * that package's `evaluate()` straight through — no adapter, no second authz model.
 */
export type AuthzDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code?: string };

export interface ServerHooks {
  /** Resolve the actor from cookies/headers. Returning `null` means anonymous. */
  readonly authenticate?: (
    request: UltimateRequest,
    ctx: RequestContext,
  ) => Promise<Actor | null> | Actor | null;
  /** Evaluate `route.meta.policy`. Required for any route that declares one. */
  readonly authorize?: (
    route: Route,
    request: UltimateRequest,
    ctx: RequestContext,
  ) => Promise<AuthzDecision> | AuthzDecision;
  /** Observability sink; the pipeline still maps the error to a response itself. */
  readonly onError?: (error: unknown, ctx: RequestContext) => void;
}
