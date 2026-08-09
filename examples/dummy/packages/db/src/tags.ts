/**
 * The cache-invalidation vocabulary. Typed handles only — `tag.post` is a `CacheTag`, and a
 * name that was never declared fails `assertKnownTags`, so a typo cannot silently invalidate
 * nothing. `x cache graph --json` prints what a write evicts before you run it.
 *
 * A tag names the *resource* (`post`), not the table (`posts`): actions, routes and live queries
 * all speak the resource, and one vocabulary is the point of tags.
 *
 * `feed` and `blog` are projections, not tables: nothing writes to them directly, so every write
 * that stales one names it in its own `cache.invalidates` — see `publishPost`. There is no
 * cascade map here on purpose: `@ultimat3/cache`'s graph maps a tag to cache keys, ISR routes,
 * CDN paths and live queries, never to another tag, so a map of tag -> tag would be a second
 * invalidation graph that nothing reads.
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
