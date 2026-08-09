/**
 * The membership predicates every surface's authz is built from. One definition each — HTTP,
 * live queries, jobs, MCP tools and the admin dashboard all evaluate these exact functions.
 */

import {
  isMemberRole,
  isOrgAdmin,
  type MemberId,
  type MemberRole,
  memberId,
  type OrgId,
  orgId as toOrgId,
} from '@postly/domain';

export type Actor = {
  readonly memberId: MemberId;
  readonly orgId: OrgId;
  readonly role: MemberRole;
};

/**
 * The subset of a framework actor these rules read. Structural on purpose: `@postly/core` holds
 * business rules and depends on no framework package, so the same predicates run in a test, a
 * job and an MCP tool without any of them importing an authz type.
 */
export type ActorLike = {
  readonly id: string;
  readonly orgId?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
};

/**
 * Project whoever is calling onto Postly's membership actor. Anyone without an org or without a
 * membership role is `null` — a policy predicate then denies on a value it can see, instead of
 * reading `undefined` off a half-built actor and deciding for the wrong reason.
 */
export const memberOf = (actor: ActorLike | null | undefined): Actor | null => {
  if (actor === null || actor === undefined) return null;
  if (actor.orgId === null || actor.orgId === undefined) return null;
  const role = (actor.roles ?? []).find(isMemberRole);
  if (role === undefined) return null;
  return { memberId: memberId(actor.id), orgId: toOrgId(actor.orgId), role };
};

export type OwnedRecord = {
  readonly orgId: OrgId;
  readonly authorId: MemberId;
};

/** Tenancy first: a matching id in the wrong org is still a denial, never a lookup miss. */
const sameOrg = (actor: Actor, record: { readonly orgId: OrgId }): boolean =>
  actor.orgId === record.orgId;

/** Owns-or-org-admin. The rule behind `post:publish`. */
export const mayPublish = (actor: Actor, post: OwnedRecord): boolean =>
  sameOrg(actor, post) && (post.authorId === actor.memberId || isOrgAdmin(actor.role));

export const mayEdit = mayPublish;

/** Admins and owners manage the roster; authors and readers cannot invite. */
export const mayInvite = (actor: Actor, orgId: OrgId): boolean =>
  actor.orgId === orgId && isOrgAdmin(actor.role);

/** Billing and org settings are owner-only: an admin can run the blog, not the contract. */
export const mayAdministerOrg = (actor: Actor, orgId: OrgId): boolean =>
  actor.orgId === orgId && actor.role === 'owner';

/** Reading the org feed needs membership and nothing more. */
export const mayReadFeed = (actor: Actor, orgId: OrgId): boolean => actor.orgId === orgId;
