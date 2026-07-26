/**
 * Authz for the posts feature. Every rule is defined once here and evaluated identically by the
 * HTTP route, the typed client, the live subscription, the job runner, the MCP tool and admin.
 * There is no second door.
 */

import { type Actor, mayPublish, mayReadFeed } from '@postly/core';
import { canAuthor, type OrgId, type PostId } from '@postly/domain';
import { definePolicy } from '@ultimat3/policy';
import { authorshipOf } from './repo';

/**
 * Owns-or-org-admin, resolved against the row rather than the request. A post in another org
 * fails on tenancy before ownership is even considered.
 */
export const ownsPost = async (actor: Actor, postId: PostId): Promise<boolean> => {
  const post = await authorshipOf(postId);
  return post !== null && mayPublish(actor, post);
};

export const postPublish = definePolicy('post:publish', {
  deny: 'errors.policyDenied',
  check: ({ actor, input }: { actor: Actor; input: { postId: PostId } }) =>
    ownsPost(actor, input.postId),
});

export const postCreate = definePolicy('post:create', {
  deny: 'errors.policyDenied',
  check: ({ actor }: { actor: Actor }) => canAuthor(actor.role),
});

/** Tenancy, resolved against the row. Two policies share it rather than restating it. */
const inActorOrg = async ({
  actor,
  input,
}: {
  actor: Actor;
  input: { postId: PostId };
}): Promise<boolean> => {
  const post = await authorshipOf(input.postId);
  return post !== null && post.orgId === actor.orgId;
};

/** Reading one post: membership in the post's org, nothing finer. Drafts stay inside the org. */
export const postRead = definePolicy('post:read', {
  deny: 'errors.policyDenied',
  check: inActorOrg,
});

/** Liking is a membership right; the same tenancy check is what keeps it tenant-safe. */
export const postLike = definePolicy('post:like', {
  deny: 'errors.policyDenied',
  check: inActorOrg,
});

/**
 * Re-evaluated at subscribe **and** per delivered row, so a post that leaves the actor's org
 * mid-stream is dropped rather than pushed.
 */
export const feedRead = definePolicy('feed:read', {
  deny: 'errors.policyDenied',
  check: ({ actor, input }: { actor: Actor; input: { orgId: OrgId } }) =>
    mayReadFeed(actor, input.orgId),
  row: ({ actor }: { actor: Actor }, row: { orgId: OrgId }) => row.orgId === actor.orgId,
});
