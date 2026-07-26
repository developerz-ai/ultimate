/**
 * The membership predicates every surface's authz is built from. One definition each — HTTP,
 * live queries, jobs, MCP tools and the admin dashboard all evaluate these exact functions.
 */

import { isOrgAdmin, type MemberId, type MemberRole, type OrgId } from '@postly/domain';

export type Actor = {
  readonly memberId: MemberId;
  readonly orgId: OrgId;
  readonly role: MemberRole;
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
