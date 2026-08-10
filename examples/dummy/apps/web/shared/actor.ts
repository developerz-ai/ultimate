/**
 * Who the request is acting as, in the shape `app/` renders: the member row, their org, the orgs
 * they may switch to, and the request clock.
 *
 * Core's `Actor` is the framework's half — id, roles, scopes, tenant — and it stays that way: a
 * framework that knew what an "org name" is would be a framework with a schema. This is the app's
 * half, it rides on the context as a service, and it is read synchronously because the streamed
 * shell in `layout.tsx` must not await anything.
 */

import type { MemberId, OrgId } from '@postly/domain';
import { useContext } from '@ultimat3/core';
import { actorHas, type KnownPermission } from '@ultimat3/policy';
import type { MemberView, OrgView } from '../app/orgs/entity';

/** One row of the org switcher: everything a member may act as, never every org in the table. */
export interface ActorOrg {
  readonly id: OrgId;
  readonly slug: string;
  readonly name: string;
}

export interface AppActor {
  readonly id: MemberId;
  readonly orgId: OrgId;
  readonly org: OrgView;
  readonly orgs: readonly ActorOrg[];
  readonly member: MemberView;
  /** The request clock, so a render never reads the wall clock and never re-reads it twice. */
  readonly now: Date;
}

/** Installed once per request, in `api/`. Declared in `shared/services.ts` like every service. */
export interface SessionService {
  actor(): AppActor;
}

export const useActor = (): AppActor => useContext().session.actor();

/**
 * Advisory client-side gate: does this actor hold the permission at all? Deliberately NOT the
 * row-level answer — `postPublish` decides on the post's authorship, and the browser does not
 * have that row. The server re-decides with it on every call, so the worst this can do is offer
 * a button the action then refuses; hiding it for someone who holds nothing is the whole point.
 */
export const useCan = (permission: KnownPermission): boolean =>
  actorHas(useContext().actor, permission);
