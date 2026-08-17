// Single responsibility: whether somebody is signed in. Both read the ambient actor from core's
// context and assert on it — they never evaluate a policy, never load a row and never look at a
// session. `@ultimat3/policy` is the only authz evaluator, so a role or scope decision does not
// live here: it is a `Policy`, which `x routes`, the manifest and `x policy list` can all see.

import type { Actor } from '@ultimat3/core';
import { isAnonymous, useContext } from '@ultimat3/core';
import { unauthenticated } from './errors';

const DEFAULT_SURFACE = 'this request';

/** Throws `X_UNAUTHENTICATED` when the ambient actor is anonymous. */
export function requireActor(surface: string = DEFAULT_SURFACE): Actor {
  const { actor } = useContext();
  if (isAnonymous(actor)) throw unauthenticated(surface);
  return actor;
}

/** Non-throwing form for a route that renders differently when signed out. */
export function currentActor(): Actor | null {
  const { actor } = useContext();
  return isAnonymous(actor) ? null : actor;
}
