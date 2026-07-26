/**
 * The cache-invalidation vocabulary. Typed handles only — `tag.post` is a `CacheTag`, and a
 * name that was never declared fails `assertKnownTags`, so a typo cannot silently invalidate
 * nothing. `x cache graph --json` prints what a write evicts before you run it.
 *
 * `feed` and `blog` are projections, not tables: nothing writes to them directly, but a write
 * to `post` or `like` must evict them. That cascade is declared here and registered with the
 * cache graph — one invalidation graph, not a second one hidden inside the tag objects.
 */

import { declareTags, tag } from '@ultimat3/cache';
import { comments } from './schema/comments';
import { likes } from './schema/likes';
import { members } from './schema/members';
import { orgs } from './schema/orgs';
import { plans } from './schema/plans';
import { posts } from './schema/posts';

/** Every entity's own tag, plus the two projections that depend on them. */
export const TAG_NAMES = [
  orgs.name,
  members.name,
  plans.name,
  posts.name,
  comments.name,
  likes.name,
  'feed',
  'blog',
] as const;

declareTags([...TAG_NAMES]);

/**
 * One import for tags across the app. `tag.post` is the whole collection; `tag('post', id)` is
 * a single row, which is what a live query subscribes to so one edit does not wake every reader.
 */
export { tag };

/** Which projections a write to each entity must also evict. Consumed by the cache graph. */
export const TAG_CASCADE: Readonly<Record<string, readonly string[]>> = {
  [posts.name]: ['feed', 'blog'],
  [likes.name]: ['feed'],
};
