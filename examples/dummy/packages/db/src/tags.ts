/**
 * The cache-invalidation graph. Typed handles only — there is no string-keyed invalidation API,
 * so an unknown tag is a compile error and `x cache graph --json` can print what a write evicts
 * before you run it.
 */

import { derivedTag, entityTag, tags } from '@ultimat3/cache';
import { comments } from './schema/comments';
import { likes } from './schema/likes';
import { members } from './schema/members';
import { orgs } from './schema/orgs';
import { plans } from './schema/plans';
import { posts } from './schema/posts';

const post = entityTag(posts);
const like = entityTag(likes);
const comment = entityTag(comments);

export const tag = tags({
  org: entityTag(orgs),
  member: entityTag(members),
  plan: entityTag(plans),
  post,
  comment,
  like,
  /** The feed is a projection of posts and likes: invalidating either cascades here. */
  feed: derivedTag('feed', [post, like]),
  /** The public blog index and its ISR pages depend on published posts only. */
  blog: derivedTag('blog', [post]),
});
