/**
 * The cache-invalidation vocabulary. Typed handles only — `tag.post` is a `CacheTag`, and a
 * name that was never declared fails `assertKnownTags`, so a typo cannot silently invalidate
 * nothing. `x cache graph --json` prints what a write evicts before you run it.
 *
 * A tag names the *resource* (`post`), not the table (`posts`): actions, routes and live queries
 * all speak the resource, and one vocabulary is the point of tags.
 *
 * `feed` and `blog` are projections, not tables: nothing writes to them directly, but a write
 * to `post` or `like` must evict them. That cascade is declared here and registered with the
 * cache graph — one invalidation graph, not a second one hidden inside the tag objects.
 */

import { declareTags, tag } from '@ultimat3/cache';

/**
 * The property form of `tag` reads this registry, so `tag.pots` is a build error rather than a
 * write that quietly invalidates nothing. Declared beside the runtime set below because the two
 * must name the same strings — a type that only agrees with itself proves nothing.
 */
declare module '@ultimat3/cache' {
  interface CacheTagRegistry {
    org: true;
    member: true;
    plan: true;
    post: true;
    comment: true;
    like: true;
    feed: true;
    blog: true;
  }
}

/** Every entity's own tag, plus the two projections that depend on them. */
export const TAG_NAMES = [
  'org',
  'member',
  'plan',
  'post',
  'comment',
  'like',
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
  post: ['feed', 'blog'],
  like: ['feed'],
};
