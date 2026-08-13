// The two seams `@ultimat3/http` leaves open, bound to the packages that own them. `authorize`
// decides for pages only, from the SAME `Policy` object every other surface evaluates — the route
// table's declared permission — so a denial in `x dev` is the one production produces.

import { actorOf } from '@ultimat3/action';
import type { AuthzDecision, ServerHooks } from '@ultimat3/http';
import { asCtx, configuredAuthenticator } from '@ultimat3/http';
import type { KnownPermission, Policy } from '@ultimat3/policy';
import { can, evaluate } from '@ultimat3/policy';
import { routeFor } from '@ultimat3/render';

/**
 * `RouteGuard.permission` is a bare string — `@ultimat3/render` keeps policy structural on
 * purpose. `can()` checks the name against the registry; this only checks the shape, so a
 * malformed guard denies with "no policy registered" instead of throwing inside the pipeline.
 */
const isPermission = (value: string): value is KnownPermission => /^[^:]+:[^:]+$/.test(value);

/** A page carries only the permission label, because that is all `RouteGuard` keeps. */
function policyFor(path: string): Policy<unknown, unknown> | undefined {
  const permission = routeFor(path)?.config.policy?.permission;
  return permission !== undefined && isPermission(permission) ? can(permission) : undefined;
}

/**
 * Both seams, never one. This returned `authorize` alone, so `hooks.authenticate` — the only
 * place an actor can come from — had no caller anywhere in the framework: every request under
 * `x dev` AND under `apps/web/server.ts` (both boot through `startRoles`) was anonymous, and
 * `auth: 'required'` was unsatisfiable. The app declares the resolver with
 * `configureAuthenticator()` at import time; this reads it back at server start, which is after
 * `loadApp` has imported the app's modules.
 *
 * Read here rather than captured at module load so a test — and a watch-mode restart — sees the
 * function the app configured, not the one that was absent when this module first evaluated.
 */
export interface DevHookOptions {
  /**
   * Dev-only findings this process accumulated for the request being answered — `x dev`'s N+1
   * ledger, and nothing else today. Passed rather than read from a module-global for the reason
   * `authorize` is passed a route: a hook that reached for the ledger itself would make every host
   * that starts a web role — `serve.ts` included — carry a diagnostic only one of them installs.
   */
  readonly devNotices?: ServerHooks['devNotices'];
}

export function devHooks(options: DevHookOptions = {}): ServerHooks {
  const authenticate = configuredAuthenticator();
  const devNotices = options.devNotices;
  return {
    ...(authenticate === undefined ? {} : { authenticate }),
    ...(devNotices === undefined ? {} : { devNotices }),
    authorize: (route, _request, ctx): AuthzDecision => {
      // An action route never arrives here: it carries `enforcedBy: 'handler'`, so the pipeline
      // never asks. `invoke` is its one evaluation, and the only one holding the row a row-level
      // rule reads — reconstructing it here would be a second authz system, one row short.
      const policy = policyFor(route.path);
      if (policy === undefined) {
        return {
          allowed: false,
          reason: `no policy is registered under ${route.meta.policy ?? route.meta.name}`,
        };
      }
      // `actorOf` is the framework's own anonymous → null mapping, so "nobody" denies with
      // X_UNAUTHENTICATED here exactly as it does inside `invoke`. The decision is passed
      // straight through: `PolicyDecision` and `AuthzDecision` are the same shape by design,
      // and an adapter here would be the beginning of a second authz model.
      const context = asCtx(ctx);
      return evaluate(policy, {
        input: ctx.input,
        actor: actorOf(context),
        row: null,
        ctx: context,
      }).decision;
    },
  };
}
