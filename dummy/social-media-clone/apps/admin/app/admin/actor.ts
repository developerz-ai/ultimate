// Who the dashboard is acting as. Read off the framework's own request context — the actor the
// HTTP pipeline resolved — so the admin cannot grow a session lookup of its own beside the app's.

import type { AdminActor } from '@ultimat3/admin';
import { type Actor, isAnonymous, tryUseContext } from '@ultimat3/core';

/**
 * `null` for anonymous, and that is a real answer rather than a missing one: `AdminAuth.actor` is
 * typed `AdminActor | null`, and every operation an unauthenticated caller asks about is refused by
 * the same `decideAll()` that refuses a signed-in actor who lacks the grant.
 */
export const adminActorFrom = (
  actor: Actor,
  locale: string,
  timeZone: string,
): AdminActor | null =>
  isAnonymous(actor) ? null : { id: actor.id, roles: actor.roles, locale, timeZone };

export interface AdminRequestActor {
  readonly actor: AdminActor | null;
  /** Every audit row is keyed by it, so a denial is traceable to the request that caused it. */
  readonly requestId: string;
}

/**
 * The actor for the in-flight request. `tryUseContext()` and not `useContext()`: the prerenderer and
 * a test call a page component with no request in flight, and "no context" is anonymous, not a crash.
 */
export const currentAdminActor = (): AdminRequestActor => {
  const ctx = tryUseContext();
  if (ctx === undefined) return { actor: null, requestId: 'no-request' };
  return { actor: adminActorFrom(ctx.actor, ctx.locale, ctx.tz), requestId: ctx.requestId };
};
