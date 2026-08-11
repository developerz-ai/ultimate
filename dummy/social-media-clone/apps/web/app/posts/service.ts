// Business logic for posts, composed from the repo. A page calls this; it never calls the repo and
// it never sees `db`.
//
// Visibility is applied HERE rather than in SQL, and that is the design rather than an oversight:
// who may read a post depends on the viewer's friend and block sets, which are a graph, not a
// column. A `where` clause would be a second, weaker copy of `canSeePost` — and the two would
// drift the first time either changed.

import type { Actor } from '../../shared/actor';
import { canSeePost } from './policy';
import { authorsById, type FeedPost, feedPage } from './repo';

/** What a rendered feed row needs. Derived from the post; the author is joined in by name. */
export interface FeedItem {
  readonly post: FeedPost;
  readonly authorHandle: string;
  readonly authorName: string;
}

/**
 * The feed a viewer may see, newest first.
 *
 * Over-fetches deliberately: the page size is what the viewer ends up seeing, but the filter runs
 * after the read, so asking for exactly `limit` rows would return fewer than `limit` whenever
 * anything is hidden. The multiplier is bounded and small — an unbounded "keep reading until full"
 * loop is how a feed becomes a table scan for the one viewer who blocked everybody.
 */
export const visibleFeed = async (
  viewer: Actor | null,
  limit: number,
  authorOf: (id: string) => { handle: string; displayName: string } | undefined,
): Promise<readonly FeedItem[]> => {
  const rows = await feedPage(limit * 3);
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
 * The feed a page renders. Wraps `visibleFeed` with the author lookup so a ROUTE never imports
 * `db` — a page reaching the database directly is X_BOUNDARY_ROUTE_TO_DB, and it is how N+1
 * queries end up inside a <head> computation.
 */
export const feedForPage = async (
  viewer: Actor | null,
  limit: number,
): Promise<readonly FeedItem[]> => {
  const authors = await authorsById();
  return visibleFeed(viewer, limit, (id) => authors.get(id));
};
