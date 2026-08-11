// Every read and write the posts feature makes. No business rules here — the service decides what
// to do, this file decides how to ask. Only this file and a query's `sql` may touch `db`; a route
// or a component importing it is X_BOUNDARY_VIOLATION.

import { db, type Post } from '@social-media-clone/db';

/**
 * What the feed renders — DERIVED from the entity, never re-declared. Writing the fields out by
 * hand is how a shape ends up declared in two places that disagree: the first draft of this file
 * said `authorId: UserId` while the column derives `string`, and the compiler caught it. Rename a
 * column and this breaks here, which is the whole point of the chain.
 */
export type FeedPost = Post;

/**
 * One page of the feed, newest first.
 *
 * Ordered by `(publishedAt desc, id)` and bounded, and the tail key is not decoration: a live
 * matcher decides a row's position from the sort keys alone, so `publishedAt` on its own is a
 * partial order and two posts written in the same millisecond can swap between evaluations —
 * which makes a bounded page silently drop or repeat one at its boundary.
 *
 * Visibility is NOT filtered here. `feedRead` decides it per row, per subscriber, because the
 * answer depends on the viewer's friend and block sets rather than on anything in the row. A
 * `where` clause here would be a second, weaker copy of that rule.
 */
export const feedPage = (limit: number): Promise<readonly FeedPost[]> =>
  db.posts
    .where({ deletedAt: null })
    .orderBy('publishedAt', 'desc')
    .orderBy('id')
    .limit(limit)
    .all();

export const byId = (id: string): Promise<FeedPost | null> => db.posts.where({ id }).one();
