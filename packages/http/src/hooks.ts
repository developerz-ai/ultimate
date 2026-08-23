// The seams the HTTP layer cannot own itself: who the actor is (auth lives in `@ultimat3/auth`,
// tier 3), whether a policy allows the call (`@ultimat3/policy` is a sibling tier, so it cannot
// be imported here), and — a seam of a different kind, deciding nothing — what a dev diagnostic
// found. All three are declared structurally, which keeps the import boundary intact and keeps
// the pipeline testable.
import type { Actor } from '@ultimat3/core';
import type { RequestContext } from './context';
import type { OverlayNotice } from './overlay';
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
  /**
   * Dev-only: non-fatal findings a diagnostic accumulated for this request, rendered next to the
   * error in the overlay. Consulted ONLY on the overlay path (`config.dev` and an HTML caller), so
   * a production process never calls it; `x dev` is the only host that supplies one.
   */
  readonly devNotices?: (ctx: RequestContext) => readonly OverlayNotice[];
  /**
   * The app's OWN error page for a status, served byte for byte, or `undefined` to render the
   * framework's. A seam and not a config value because the answer lives on a disk this package
   * cannot see: `@ultimat3/cli` reads `apps/web/site/errors/<status>.html`, per request, so a file
   * dropped into a running server takes effect without a restart — the rule `/favicon.ico`
   * already follows for the same class of file.
   *
   * Consulted only on the production HTML path: a dev process answers a browser with the overlay,
   * and an agent gets the problem document in both.
   */
  readonly errorPage?: (
    status: number,
    ctx: RequestContext,
  ) => Promise<string | undefined> | string | undefined;
}

export type Authenticator = NonNullable<ServerHooks['authenticate']>;

/**
 * The app's authenticator, if it declared one. A single value and not a list: two functions
 * answering "who is this?" is two identities per request, and the one that ran first wins —
 * the same failure `enforcedBy` exists to prevent one layer up.
 *
 * It is process-global for the reason `registerActions` and `defineService` are: the app has
 * exactly one boot, and every host that starts a server (`x dev`, `apps/web/server.ts`) would
 * otherwise need its own way to be handed the same function. `@ultimat3/auth` cannot supply it
 * — it is tier 2, as this package is, so it can never import this one; the app is the only
 * place both are in scope, and that is where the wire belongs.
 */
let configured: Authenticator | undefined;

export const configureAuthenticator = (authenticate: Authenticator): void => {
  configured = authenticate;
};

/** What a host passes as `hooks.authenticate`. `undefined` means every request is anonymous. */
export const configuredAuthenticator = (): Authenticator | undefined => configured;

/** Test seam. Production configures once at boot and never unconfigures. */
export const resetAuthenticator = (): void => {
  configured = undefined;
};
