// Who may see a post. In `shared/` because BOTH surfaces need it: `site/` renders public profiles
// and the public feed, `app/` renders the signed-in feed — and `site/` may not import `app/`.
// Moving it here is the alternative to writing the rule twice, which is how two copies drift.

import { type Audience, isVisibleAudience } from '@social-media-clone/domain';
import { type Actor, isBlocked, isFriend, isSelf } from './actor';

/** The row facts every post rule decides about. Loaded by the surface, never fetched in a rule. */
export interface PostRow {
  readonly authorId: string;
  readonly audience: Audience;
  readonly deletedAt: Date | null;
}

/**
 * The one rule everything else is built on, in the order the checks must happen.
 *
 * Blocks come FIRST and are checked in both directions. Putting the audience ladder first would
 * make a `public` post visible to someone who blocked its author — the ladder answers "is this
 * post for people like you", and a block says "not you specifically", so the specific rule has to
 * win. A deleted post is invisible to everyone including its author; the author reads it back
 * through the moderation path, not this one.
 */
export const canSeePost = (actor: Actor | null, post: PostRow): boolean => {
  if (post.deletedAt !== null) return false;
  if (isBlocked(actor, post.authorId)) return false;
  if (isSelf(actor, post.authorId)) return true;
  return isVisibleAudience(post.audience, isFriend(actor, post.authorId));
};
