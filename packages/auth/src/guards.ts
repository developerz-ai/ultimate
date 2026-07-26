// Single responsibility: the assertions the http pipeline's auth stage runs. They read the
// ambient actor from core's context and assert on it — they never evaluate a policy, never
// load a row and never look at a session. `@ultimat3/policy` is the only authz evaluator;
// duplicating even a little of it here would be the second authz system the framework forbids.

import type { Actor } from '@ultimat3/core';
import { hasRole, hasScope, isAnonymous, useContext } from '@ultimat3/core';
import { forbidden, unauthenticated } from './errors';

const DEFAULT_SURFACE = 'this request';

/** Throws `X_UNAUTHENTICATED` when the ambient actor is anonymous. */
export function requireActor(surface: string = DEFAULT_SURFACE): Actor {
  const { actor } = useContext();
  if (isAnonymous(actor)) throw unauthenticated(surface);
  return actor;
}

/**
 * A coarse role gate for routes that are role-shaped rather than permission-shaped (an admin
 * area). Anything finer belongs in a policy — `can('post:publish')`, evaluated by policy.
 */
export function requireRole(role: string, surface: string = DEFAULT_SURFACE): Actor {
  const actor = requireActor(surface);
  if (!hasRole(actor, role)) throw forbidden(surface, `actor lacks role "${role}"`);
  return actor;
}

/**
 * The api-key path: an agent's scopes are exactly its key's scopes, so a scope check is a
 * credential check, not an authorization decision.
 */
export function requireScope(scope: string, surface: string = DEFAULT_SURFACE): Actor {
  const actor = requireActor(surface);
  if (!hasScope(actor, scope)) throw forbidden(surface, `actor lacks scope "${scope}"`);
  return actor;
}

/** Non-throwing form for a route that renders differently when signed out. */
export function currentActor(): Actor | null {
  const { actor } = useContext();
  return isAnonymous(actor) ? null : actor;
}
