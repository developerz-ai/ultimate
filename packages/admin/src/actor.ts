// Who the dashboard is acting as, by default: the actor the HTTP pipeline already resolved for
// this request, read off the framework's own request context — so the admin cannot grow a session
// lookup of its own beside the app's.

import {
  type Actor,
  type ActorInit,
  agentActor,
  anonymousActor,
  isAnonymous,
  serviceActor,
  tryUseContext,
  userActor,
} from '@ultimat3/core';
import type { AdminActor } from './authz';

/**
 * Core's actor as the admin carries it — the ONE mapping in, used by the request actor below and
 * by `mcp.ts`'s caller. Kind, scopes and `onBehalfOf` cross with the grants and the tenant: a rule
 * written against core's `Actor` must see the same facts here as on the app's own routes. Absent
 * stays ABSENT (no `undefined` keys), so "single-tenant" and "dropped" never look alike.
 */
export const adminActorOf = (actor: Actor): AdminActor => ({
  id: actor.id,
  kind: actor.kind,
  roles: actor.roles,
  ...(actor.permissions.length === 0 ? {} : { permissions: actor.permissions }),
  ...(actor.scopes.length === 0 ? {} : { scopes: actor.scopes }),
  ...(actor.orgId === undefined ? {} : { orgId: actor.orgId }),
  ...(actor.onBehalfOf === undefined ? {} : { onBehalfOf: actor.onBehalfOf }),
});

/**
 * The ONE mapping back: the core `Actor` a policy evaluates and a worker installs, of the admin
 * actor's real kind. A missing kind is `'user'` — every `AdminActor` an app built by hand before
 * the field existed. Locale and zone stay the request's (`ctx`), not the actor's saved ones.
 */
export const coreActorOf = (actor: AdminActor): Actor => {
  const kind = actor.kind ?? 'user';
  if (kind === 'anonymous') return anonymousActor();
  const init: ActorInit = {
    id: actor.id,
    roles: actor.roles ?? [],
    permissions: actor.permissions ?? [],
    scopes: actor.scopes ?? [],
    orgId: actor.orgId,
    onBehalfOf: actor.onBehalfOf,
  };
  if (kind === 'agent') return agentActor(init);
  return kind === 'service' ? serviceActor(init) : userActor(init);
};

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
): AdminActor | null => (isAnonymous(actor) ? null : { ...adminActorOf(actor), locale, timeZone });

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
