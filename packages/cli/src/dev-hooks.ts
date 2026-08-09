// The two seams `@ultimat3/http` leaves open, bound to the packages that own them. `authorize`
// evaluates the SAME `Policy` object every other surface evaluates — the action registry's for an
// action route, the route table's declared permission for a page — so a denial in `x dev` is the
// denial production produces, not a dev-only approximation.

import { actorOf, getAction } from '@ultimat3/action';
import type { AuthzDecision, ServerHooks } from '@ultimat3/http';
import { asCtx } from '@ultimat3/http';
import type { KnownPermission, Policy } from '@ultimat3/policy';
import { can, evaluate } from '@ultimat3/policy';
import { routeFor } from '@ultimat3/render';

/**
 * `RouteGuard.permission` is a bare string — `@ultimat3/render` keeps policy structural on
 * purpose. `can()` checks the name against the registry; this only checks the shape, so a
 * malformed guard denies with "no policy registered" instead of throwing inside the pipeline.
 */
const isPermission = (value: string): value is KnownPermission => /^[^:]+:[^:]+$/.test(value);

/**
 * An action carries its policy object; a `route` carries only the permission label, because that
 * is all `RouteGuard` keeps. Reconstructing the label's check with `can()` is exact for a route
 * and would be a guess for an action — which is why actions are looked up, never reconstructed.
 */
function policyFor(name: string, path: string): Policy<unknown, unknown> | undefined {
  const action = getAction(name);
  if (action !== undefined) return action.policy;
  const permission = routeFor(path)?.config.policy?.permission;
  return permission !== undefined && isPermission(permission) ? can(permission) : undefined;
}

export function devHooks(): ServerHooks {
  return {
    authorize: (route, _request, ctx): AuthzDecision => {
      const policy = policyFor(route.meta.name, route.path);
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
