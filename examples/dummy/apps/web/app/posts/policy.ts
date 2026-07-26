/**
 * Authz for the posts feature. Every rule is defined once here and evaluated identically by the
 * HTTP route, the typed client, the live subscription, the job runner, the MCP tool and admin.
 * There is no second door.
 *
 * Rules are pure functions of the actor and the input. Where a decision depends on a row, the
 * caller loads it and passes it in — see the `PostSubject` type below. That is more work at the
 * call site than letting the rule fetch what it needs, and it is deliberate: a live query
 * evaluates policy per subscriber on every change, so a rule that reads a row would turn one
 * insert into one query per watcher.
 */

import { type Actor, mayPublish, mayReadFeed } from '@postly/core';
import { canAuthor, type OrgId, type PostId } from '@postly/domain';
import { definePolicy } from '@ultimat3/policy';
import { authorshipOf } from './repo';

/** The row facts every post rule decides on. Loaded once per request, then reused. */
export interface PostSubject {
  readonly postId: PostId;
  readonly post: { readonly orgId: OrgId; readonly authorId: string } | null;
}

/**
 * Load the row a post rule needs. Call this once in the surface (an action's handler, a live
 * query's subscribe) and pass the result as `input` — never inside a rule.
 */
export const loadPostSubject = async (postId: PostId): Promise<PostSubject> => ({
  postId,
  post: await authorshipOf(postId),
});

/** Owns-or-org-admin, decided against the already-loaded row. */
export const ownsPost = (actor: Actor, subject: PostSubject): boolean =>
  subject.post !== null && mayPublish(actor, subject.post);

export const postPublish = definePolicy<PostSubject>('post:publish', {
  deny: 'errors.policyDenied',
  check: ({ actor, input }) => actor !== null && ownsPost(actor as Actor, input),
});

export const postCreate = definePolicy<unknown>('post:create', {
  deny: 'errors.policyDenied',
  check: ({ actor }) => actor !== null && canAuthor((actor as Actor).role),
});

/** Tenancy, decided against the row. Two policies share it rather than restating it. */
const inActorOrg = ({ actor, input }: { actor: unknown; input: PostSubject }): boolean =>
  actor !== null && input.post !== null && input.post.orgId === (actor as Actor).orgId;

/** Reading one post: membership in the post's org, nothing finer. Drafts stay inside the org. */
export const postRead = definePolicy<PostSubject>('post:read', {
  deny: 'errors.policyDenied',
  check: inActorOrg,
});

/** Liking is a membership right; the same tenancy check is what keeps it tenant-safe. */
export const postLike = definePolicy<PostSubject>('post:like', {
  deny: 'errors.policyDenied',
  check: inActorOrg,
});

/**
 * Re-evaluated at subscribe and again per delivered row, so a post that leaves the actor's org
 * mid-stream is dropped rather than pushed. The per-row check is `rowInActorOrg`, applied by
 * the live query — it stays a plain predicate so the matcher can run it on every change without
 * touching the database.
 */
export const feedRead = definePolicy<{ orgId: OrgId }>('feed:read', {
  deny: 'errors.policyDenied',
  check: ({ actor, input }) => actor !== null && mayReadFeed(actor as Actor, input.orgId),
});

/** Per-delivered-row guard for `feedRead`. Pure, so the matcher can apply it per change event. */
export const rowInActorOrg = (actor: Actor, row: { readonly orgId: OrgId }): boolean =>
  row.orgId === actor.orgId;
