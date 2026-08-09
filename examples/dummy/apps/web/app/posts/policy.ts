/**
 * Authz for the posts feature. Every rule is defined once here and evaluated identically by the
 * HTTP route, the typed client, the live subscription, the job runner, the MCP tool and admin.
 * There is no second door.
 *
 * Predicates are synchronous, which is the constraint everything else follows from: a live query
 * re-evaluates one per subscriber on every change, so an `await` here would be a database round
 * trip per row per connected client. A rule therefore decides on two things only — the actor, and
 * facts the caller already had. Tenancy travels in the action's `input`; a rule about an
 * already-loaded post reads `row`, which the surface loaded and passed in.
 */

import { type Actor, mayPublish, mayReadFeed, memberOf } from '@postly/core';
import { canAuthor, type MemberId, type OrgId } from '@postly/domain';
import { can, definePermissions } from '@ultimat3/policy';

/**
 * The permission set, declared rather than assumed. The augmentation narrows `can()` to these
 * strings, so a typo is a build error instead of a rule that silently never matches; the
 * `definePermissions()` call is the same set at runtime, and it runs before any `can()` below.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'post:create': true;
    'post:publish': true;
    'post:read': true;
    'post:like': true;
    'feed:read': true;
  }
}

export const postPermissions = definePermissions([
  'post:create',
  'post:publish',
  'post:read',
  'post:like',
  'feed:read',
]);

/** What every post rule decides on. Actions and queries both put it in their `input`. */
export interface PostScope {
  readonly orgId: OrgId;
}

/** The row facts a post rule decides about, once a surface has loaded the post. */
export interface PostRow {
  readonly orgId: OrgId;
  readonly authorId: MemberId;
}

/** Owns-or-org-admin, decided against the already-loaded row. */
export const ownsPost = (actor: Actor, post: PostRow): boolean => mayPublish(actor, post);

// `can()` checks the grant first and the predicate second, so a denial distinguishes "you may
// never do this" from "you may, but not in that org" — an agent can act on the difference. The
// predicates below add tenancy and authorship only; the grant is never re-checked by hand.

/** Authoring is a role right, inside the actor's own org. */
export const postCreate = can<PostScope>('post:create', ({ actor, input }) => {
  const member = memberOf(actor);
  return member !== null && member.orgId === input.orgId && canAuthor(member.role);
});

/**
 * Owns-or-org-admin, on a row the surface loaded. Tenancy is necessary and never sufficient: an
 * actor may publish inside their own org, and inside it only their own drafts unless they are an
 * admin.
 *
 * `row === null` is a DENIAL, not a pass. It used to mean "the surface did not load a post, so
 * there is nothing to object to", which handed every same-org holder of `post:publish` a way to
 * publish a colleague's draft — the caller simply never passed a row. `null` carries no evidence
 * of authorship, and a rule that treats an absent fact as a satisfied one is a rule that fails
 * open. The row now arrives from `publishPost`'s `row:` loader, which runs once per invocation
 * before the guard.
 */
export const postPublish = can<PostScope, PostRow>('post:publish', ({ actor, input, row }) => {
  const member = memberOf(actor);
  if (member === null || member.orgId !== input.orgId) return false;
  return row !== null && ownsPost(member, row);
});

/** Reading one post: membership in the post's org, nothing finer. Drafts stay inside the org. */
export const postRead = can<PostScope>(
  'post:read',
  ({ actor, input }) => memberOf(actor)?.orgId === input.orgId,
);

/** Liking is a membership right; the same tenancy check is what keeps it tenant-safe. */
export const postLike = can<PostScope>(
  'post:like',
  ({ actor, input }) => memberOf(actor)?.orgId === input.orgId,
);

/**
 * Re-evaluated at subscribe and again per delivered row, so a post that leaves the actor's org
 * mid-stream is dropped rather than pushed. The per-row branch reads `row`, which the matcher
 * passes without touching the database.
 *
 * `row === null` allows here, and unlike `postPublish` that is deliberate rather than a hole. The
 * subscribe call genuinely has no row — @ultimat3/realtime passes `null` at subscribe time and the
 * loaded row on every delivery — and the question being asked at subscribe is "may this member
 * read this org's feed", which `mayReadFeed` above has already answered in full. The null branch
 * grants nothing the line before it did not; it says "no further row-level objection", not "skip
 * the check". `postPublish` was different because authorship was the ONLY thing its row branch
 * checked, so skipping it skipped the rule.
 */
export const feedRead = can<PostScope, PostRow>('feed:read', ({ actor, input, row }) => {
  const member = memberOf(actor);
  if (member === null || !mayReadFeed(member, input.orgId)) return false;
  return row === null || row.orgId === member.orgId;
});
