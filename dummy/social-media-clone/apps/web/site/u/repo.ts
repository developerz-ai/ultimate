// Every read the public profile makes. No rules here — `service.ts` decides what a stranger may
// see, this file decides how to ask. Only this file touches `db`; the page imports the service.
//
// Who may read a post is decided by `canSeePost`, once, in `service.ts`, over every row read here.
// `publicPostsByAuthor` asks only for the rows that rule admits an ANONYMOUS reader — live and
// public, all AND — so an anonymous page is exact; it narrows the read, it never decides.

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

/**
 * One author's PUBLIC timeline — the rows `canSeePost(null, …)` admits — newest first, exactly
 * `limit` of them however much of the timeline is hidden. Same order as `postsByAuthor`, so the
 * anonymous page is the signed-in rule's answer for a null viewer, read without the over-fetch.
 */
export const publicPostsByAuthor = (authorId: string, limit: number): Promise<readonly Post[]> =>
  db.posts
    .where({ authorId, audience: 'public', deletedAt: null })
    .orderBy('publishedAt', 'desc')
    .orderBy('id')
    .limit(limit)
    .all();
