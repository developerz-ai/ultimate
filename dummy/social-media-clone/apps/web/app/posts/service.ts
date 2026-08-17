// Business logic for posts, composed from the repo. A page calls this; it never calls the repo and
// it never sees `db`.
//
// Visibility is applied HERE rather than in SQL, and that is the design rather than an oversight:
// who may read a post depends on the viewer's friend and block sets, which are a graph, not a
// column. A `where` clause would be a second, weaker copy of `canSeePost` — and the two would
// drift the first time either changed.

import type { Actor } from '../../shared/actor';
import { canSeePost } from './policy';
import { authorsByIds, type FeedPost, feedPage } from './repo';

/** What a rendered feed row needs. Derived from the post; the author is joined in by name. */
export interface FeedItem {
  readonly post: FeedPost;
  readonly authorHandle: string;
  readonly authorName: string;
}

/**
 * The feed a viewer may see, newest first — the filter, over rows somebody else read.
 *
 * Synchronous and pure on purpose: `canSeePost` is the rule, and a rule that can be handed a page
 * and an author lookup is a rule a test can drive with neither a database nor a renderer.
 */
export const visibleFeed = (
  viewer: Actor | null,
  limit: number,
  authorOf: (id: string) => { handle: string; displayName: string } | undefined,
  rows: readonly FeedPost[],
): readonly FeedItem[] => {
  const items: FeedItem[] = [];
  for (const post of rows) {
    if (items.length >= limit) break;
    if (!canSeePost(viewer, post)) continue;
    const author = authorOf(post.authorId);
    if (author === undefined) continue;
    items.push({ post, authorHandle: author.handle, authorName: author.displayName });
  }
  return items;
};

/**
 * The feed a page renders: two statements, in this order, and the order is the point. The page is
 * read first so the author lookup can name the ids that page actually holds — the read this
 * replaced asked for "some 200 users" before it knew which ones it needed.
 *
 * It wraps `visibleFeed` so a ROUTE never imports `db` — a page reaching the database directly is
 * X_BOUNDARY_ROUTE_TO_DB, and it is how N+1 queries end up inside a <head> computation.
 *
 * Over-fetches deliberately: the page size is what the viewer ends up seeing, but the filter runs
 * after the read, so asking for exactly `limit` rows would return fewer than `limit` whenever
 * anything is hidden. The multiplier is bounded and small — an unbounded "keep reading until full"
 * loop is how a feed becomes a table scan for the one viewer who blocked everybody.
 */
export const feedForPage = async (
  viewer: Actor | null,
  limit: number,
): Promise<readonly FeedItem[]> => {
  const rows = await feedPage(limit * 3);
  const authors = await authorsByIds(rows.map((post) => post.authorId));
  return visibleFeed(viewer, limit, (id) => authors.get(id), rows);
};
