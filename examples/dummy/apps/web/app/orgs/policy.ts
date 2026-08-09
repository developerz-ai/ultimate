/**
 * Authz for orgs and membership. Every rule is one call into `@postly/core`, so the admin app and
 * the MCP tools cannot drift from the web app — they evaluate the same `Policy` objects.
 */

import { mayAdministerOrg, mayInvite, memberOf } from '@postly/core';
import type { OrgId } from '@postly/domain';
import { can, definePermissions } from '@ultimat3/policy';

/**
 * Declared twice on purpose: the augmentation makes a typo a build error, the
 * `definePermissions()` call is the same set at runtime, and it runs before any `can()` below.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'org:invite': true;
    'org:administer': true;
    'member:self': true;
  }
}

export const orgPermissions = definePermissions(['org:invite', 'org:administer', 'member:self']);

/** What every org rule decides on. The tenant is in the input, never fetched by a rule. */
export interface OrgScope {
  readonly orgId: OrgId;
}

/** Admins and owners manage the roster. */
export const orgInvite = can<OrgScope>('org:invite', ({ actor, input }) => {
  const member = memberOf(actor);
  return member !== null && mayInvite(member, input.orgId);
});

/** Billing is owner-only: an admin runs the blog, the owner signs the contract. */
export const orgAdminister = can<OrgScope>('org:administer', ({ actor, input }) => {
  const member = memberOf(actor);
  return member !== null && mayAdministerOrg(member, input.orgId);
});

/** Anyone may edit their own preferences — and only their own. */
export const memberSelf = can<{ readonly memberId?: string }>('member:self', ({ actor, input }) => {
  const member = memberOf(actor);
  return member !== null && (input.memberId === undefined || input.memberId === member.memberId);
});
