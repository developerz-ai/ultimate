// The two seams `@ultimat3/http` leaves open, bound to the packages that own them. `authorize`
// decides for pages only, from the SAME `Policy` object every other surface evaluates — the route
// table's declared permission — so a denial in `x dev` is the one production produces.

import { actorOf } from '@ultimat3/action';
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

/** A page carries only the permission label, because that is all `RouteGuard` keeps. */
function policyFor(path: string): Policy<unknown, unknown> | undefined {
  const permission = routeFor(path)?.config.policy?.permission;
  return permission !== undefined && isPermission(permission) ? can(permission) : undefined;
}

export function devHooks(): ServerHooks {
  return {
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
