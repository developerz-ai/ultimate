/**
 * Who the request is acting as, in the shape `app/` renders: the member row, their org, and the
 * request clock.
 *
 * Core's `Actor` is the framework's half — id, roles, scopes, tenant — and it stays that way: a
 * framework that knew what an "org name" is would be a framework with a schema. This is the app's
 * half, and it rides on that SAME actor as declared FACTS, resolved once at the request boundary,
 * which is what makes it readable synchronously by a streamed shell that must not await anything.
 *
 * It was a `ctx.session` service until 2026-08, and that was a second answer to "who is calling":
 * every policy rule in this app is handed an `Actor` and nothing else (`memberOf` in
 * `@postly/core`), so a second identity on the context is one no rule can read — and nothing ever
 * registered the service, so every `app/` render was a `TypeError` on `undefined.actor()`.
 */

import type { MemberId, OrgId } from '@postly/domain';
import { memberId, orgId } from '@postly/domain';
import { type Actor, actorFact, useContext, userActor } from '@ultimat3/core';
import { actorHas, type KnownPermission } from '@ultimat3/policy';
import type { MemberView, OrgView } from '../app/orgs/entity';
import { ActorUnresolved } from './errors';

/**
 * Postly's authz facts, declared once on core's extension seam. They are the two rows every `app/`
 * page draws; the id, the tenant and the role stay on the actor itself, where `memberOf()` reads
 * them. Optional per key by construction — `actorFact()` answers `undefined` for an actor nobody
 * resolved, which is what makes `ActorUnresolved` a decision instead of a guess.
 */
declare module '@ultimat3/core' {
  interface ActorFacts {
    readonly member: MemberView;
    readonly org: OrgView;
  }
}

export interface AppActor {
  readonly id: MemberId;
  readonly orgId: OrgId;
  readonly org: OrgView;
  readonly member: MemberView;
  /** The request clock, so a render never reads the wall clock and never re-reads it twice. */
  readonly now: Date;
}

/**
 * The one constructor for a signed-in Postly actor — the request boundary in production, and any
 * fixture that needs one. A hand-built object literal would be a second answer to what carries the
 * member row, and the first thing to drift when a fact is added.
 *
 * `roles: [member.role]` and not a bare role field: `@ultimat3/policy` expands `actor.roles` into
 * the permission set, so the membership column IS the grant with no mapping table in between.
 */
export const postlyActor = (init: { readonly member: MemberView; readonly org: OrgView }): Actor =>
  userActor({
    id: init.member.id,
    orgId: init.member.orgId,
    roles: [init.member.role],
    facts: { member: init.member, org: init.org },
  });

/** The app half of the acting member. `X_ACTOR_UNRESOLVED` when nothing resolved it. */
export const useActor = (): AppActor => {
  const ctx = useContext();
  const member = actorFact(ctx.actor, 'member');
  const org = actorFact(ctx.actor, 'org');
  if (member === undefined || org === undefined) throw new ActorUnresolved();
  return {
    id: memberId(member.id),
    orgId: orgId(member.orgId),
    org,
    member,
    now: ctx.now(),
  };
};

/**
 * Advisory client-side gate: does this actor hold the permission at all? Deliberately NOT the
 * row-level answer — `postPublish` decides on the post's authorship, and the browser does not
 * have that row. The server re-decides with it on every call, so the worst this can do is offer
 * a button the action then refuses; hiding it for someone who holds nothing is the whole point.
 */
export const useCan = (permission: KnownPermission): boolean =>
  actorHas(useContext().actor, permission);
