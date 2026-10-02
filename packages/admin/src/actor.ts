// Who the dashboard is acting as, by default: the actor the HTTP pipeline already resolved for
// this request, read off the framework's own request context — so the admin cannot grow a session
// lookup of its own beside the app's.

import { type Actor, isAnonymous, tryUseContext } from '@ultimat3/core';
import type { AdminActor } from './authz';

/**
 * `null` for anonymous, and that is a real answer rather than a missing one: every operation an
 * unauthenticated caller asks about is refused by the same `decideAll()` that refuses a signed-in
 * actor who lacks the grant. The tenant rides along — a role-only rule would otherwise allow a row
 * from another org.
 */
export const adminActorFrom = (
  actor: Actor,
  locale: string,
  timeZone: string,
): AdminActor | null =>
  isAnonymous(actor)
    ? null
    : {
        id: actor.id,
        roles: actor.roles,
        locale,
        timeZone,
        ...(actor.orgId === undefined ? {} : { orgId: actor.orgId }),
      };

export interface AdminRequestActor {
  readonly actor: AdminActor | null;
  /** Every audit row is keyed by it, so a denial is traceable to the request that caused it. */
  readonly requestId: string;
}

/** The id an audit row carries when no request is in flight — a prerender, a script, a test. */
export const NO_REQUEST_ID = 'no-request';

/**
 * The actor for the in-flight request. `tryUseContext()` and not `useContext()`: a test calls a
 * screen with no request in flight, and "no context" is anonymous, not a crash.
 */
export const requestActor = (): AdminRequestActor => {
  const ctx = tryUseContext();
  if (ctx === undefined) return { actor: null, requestId: NO_REQUEST_ID };
  return { actor: adminActorFrom(ctx.actor, ctx.locale, ctx.tz), requestId: ctx.requestId };
};

/**
 * Anonymous is a real actor id on a decision — `decideAll()` refuses it exactly as it refuses a
 * signed-in actor missing the grant, and an audit row that says `anonymous` is more useful than
 * one that says nothing.
 */
export const ANONYMOUS_ADMIN_ACTOR: AdminActor = Object.freeze({ id: 'anonymous', roles: [] });
