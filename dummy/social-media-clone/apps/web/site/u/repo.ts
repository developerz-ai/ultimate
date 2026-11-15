// Every read the public profile makes. No rules here — `service.ts` decides what a stranger may
// see, this file decides how to ask. Only this file touches `db`; the page imports the service.
//
// Who may read a post is decided by `canSeePost`, once, in `service.ts`, over every row read here.
// `postsByAuthor` asks only for the audiences that rule admits the viewer — on ONE author's page
// that is a list, never an OR — so every page is exact; it narrows the read, it never decides.

import { db, type Post, type User } from '@social-media-clone/db';
import type { Audience } from '@social-media-clone/domain';

export type { Post, User };

/** The profile lookup is by handle and nothing else — the unique index on `handle` exists for it. */
export const userByHandle = (handle: string): Promise<User | null> =>
  db.users.where({ handle }).one();

/**
 * One author's live posts in `audiences`, newest first, exactly `limit` of them however much of the
 * timeline is hidden. Ordered by `(publishedAt desc, id)`: `publishedAt` alone is a partial order,
 * so two posts written in the same millisecond could swap between reads and a bounded page would
 * silently drop or repeat one at its boundary.
 */
export const postsByAuthor = (
  authorId: string,
  audiences: readonly Audience[],
  limit: number,
): Promise<readonly Post[]> =>
  db.posts
    .where({ authorId, deletedAt: null })
    .andWhere('audience', 'in', audiences)
    .orderBy('publishedAt', 'desc')
    .orderBy('id')
    .limit(limit)
    .all();
