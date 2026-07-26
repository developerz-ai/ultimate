/**
 * Authz for orgs and membership. Both rules are one call into `@postly/core`, so the admin app
 * and the MCP tools cannot drift from the web app — they import the same predicate.
 */

import { type Actor, mayAdministerOrg, mayInvite } from '@postly/core';
import { definePolicy } from '@ultimat3/policy';

/** Admins and owners manage the roster. */
export const orgInvite = definePolicy('org:invite', {
  deny: 'errors.policyDenied',
  check: ({ actor }: { actor: Actor }) => mayInvite(actor, actor.orgId),
});

/** Billing is owner-only: an admin runs the blog, the owner signs the contract. */
export const orgAdminister = definePolicy('org:administer', {
  deny: 'errors.policyDenied',
  check: ({ actor }: { actor: Actor }) => mayAdministerOrg(actor, actor.orgId),
});

/** Anyone may edit their own preferences — and only their own. */
export const memberSelf = definePolicy('member:self', {
  deny: 'errors.policyDenied',
  check: ({ actor, input }: { actor: Actor; input: { memberId?: string } }) =>
    input.memberId === undefined || input.memberId === actor.memberId,
});
