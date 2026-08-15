/**
 * App-global authz: who holds which permission, and the one rule the anonymous surface needs.
 * Both surfaces evaluate what is here — `site/` being anonymous is a policy decision, not the
 * absence of one, and writing it down means the public blog cannot accidentally serve a draft.
 */

import type { MemberRole } from '@postly/domain';
import { allow, defineRoles, type RoleDef } from '@ultimat3/policy';

/**
 * Membership role → permissions, in one place. The `satisfies` clause is keyed by `MemberRole`, so
 * a role added to `@postly/domain` without a grant here is a build error rather than an actor who
 * silently holds nothing.
 *
 * Roles are sugar: everything is expanded to a flat permission set before any policy runs, so a
 * rule never reasons about the hierarchy. `defineRoles()` replaces the map wholesale — it is app
 * state, called exactly once, from the leaf both surfaces already import.
 */
export const roles = defineRoles({
  reader: {
    description: 'Reads the org feed, comments and likes.',
    grants: ['feed:read', 'post:read', 'post:like', 'member:self'],
  },
  author: {
    description: 'Writes and publishes their own posts.',
    grants: ['post:create', 'post:publish'],
    inherits: ['reader'],
  },
  admin: {
    description: 'Runs the blog: the roster, and anyone’s post.',
    grants: ['org:invite'],
    inherits: ['author'],
  },
  owner: {
    description: 'Signs the contract. Billing is owner-only.',
    grants: ['org:administer'],
    inherits: ['admin'],
  },
} satisfies Record<MemberRole, RoleDef>);

/**
 * The only rule the static surface needs, said out loud: the public blog is readable without a
 * session. `can('...')` is the other branch and would deny every visitor, because an anonymous
 * actor holds no grant; a missing policy is a build error, so "anyone may read this" has to be a
 * declaration too.
 *
 * "Published only" is deliberately NOT here. A policy owns the yes/no and never returns partial
 * data — the `status: 'published'` filter lives in the query, where it also bounds the SQL and
 * the prerender list. Splitting it would give a draft two ways to leak instead of none.
 */
export const publicPostRead = allow('post:read-public');

/**
 * The other one, and the only *write* the anonymous surface is allowed: a sales enquiry from
 * `/pricing`'s contact modal. Spelled out for the same reason the read above is — an action
 * without a policy is a build error, so "anyone may send this" has to be a declaration too, and
 * writing it here keeps both public rules in the one file a reviewer reads to answer "what can a
 * stranger do?".
 */
export const contactSubmit = allow('contact:submit');
