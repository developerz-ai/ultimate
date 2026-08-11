// What a reader may see on somebody's profile. The rule is `canSeePost` and only `canSeePost` —
// imported from the posts feature rather than restated, because a second copy of "who may read
// this" is how a friends-only post ends up on an anonymous page.
//
// The import crosses site/ -> app/, which `x verify` reports as X_BOUNDARY_SITE_TO_APP. That is a
// real finding and not a shrug: `site/feed/page.tsx` already crosses it the same way. The right
// repair is to move the visibility rule down into `shared/` (a leaf both surfaces may import), not
// to write the rule twice — and moving it means editing the posts feature, which this slice does
// not own. Recorded here so the next reader knows which of the two options was rejected and why.

import { canSeePost } from '../../app/posts/policy';
import type { Actor } from '../../shared/actor';
import type { Post, User } from './repo';
import { postsByAuthor, userByHandle } from './repo';

export interface ProfileView {
  readonly user: User;
  readonly posts: readonly Post[];
}

/** Bounded, and over-fetched: the filter runs after the read, so asking for exactly `limit` rows
 * would return fewer than `limit` whenever anything is hidden. The multiplier is small and fixed —
 * an unbounded "keep reading until full" loop is how a profile becomes a table scan for the one
 * author whose posts are all private. */
const OVERFETCH = 3;

/**
 * A profile as one viewer may see it. `viewer === null` is an anonymous reader, and that is a
 * decision written down rather than the absence of one: the audience ladder answers `public` and
 * nothing else for them, so a friends-only post, a private note and a soft-deleted row are all
 * absent from `posts` WITHOUT a `where` clause saying so.
 */
export const publicProfile = async (
  viewer: Actor | null,
  handle: string,
  limit = 20,
): Promise<ProfileView | null> => {
  const user = await userByHandle(handle);
  if (user === null) return null;

  const rows = await postsByAuthor(user.id, limit * OVERFETCH);
  const posts: Post[] = [];
  for (const post of rows) {
    if (posts.length >= limit) break;
    if (canSeePost(viewer, post)) posts.push(post);
  }
  return { user, posts };
};
