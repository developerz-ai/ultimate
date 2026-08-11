// Every read the public profile makes. No rules here — `service.ts` decides what a stranger may
// see, this file decides how to ask. Only this file touches `db`; the page imports the service.
//
// There is deliberately NO `where({ audience: 'public' })` below. Who may read a post is decided by
// `canSeePost`, once; a filter here would be a second, weaker copy of that rule, and the two would
// drift the first time either changed.

import { db, type Post, type User } from '@social-media-clone/db';

export type { Post, User };

/** The profile lookup is by handle and nothing else — the unique index on `handle` exists for it. */
export const userByHandle = (handle: string): Promise<User | null> =>
  db.users.where({ handle }).one();

/**
 * One author's timeline, newest first, bounded. Ordered by `(publishedAt desc, id)`: `publishedAt`
 * alone is a partial order, so two posts written in the same millisecond could swap between reads
 * and a bounded page would silently drop or repeat one at its boundary.
 */
export const postsByAuthor = (authorId: string, limit: number): Promise<readonly Post[]> =>
  db.posts.where({ authorId }).orderBy('publishedAt', 'desc').orderBy('id').limit(limit).all();
