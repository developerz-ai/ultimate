// Every read the dashboard makes. No rules here — `screen.ts` decides what the viewer may see and
// how the figures are cut, this file decides how to ask. Only this file touches `db`; the page
// imports the screen, never this (X_BOUNDARY_ROUTE_TO_DB).
//
// Every read is bounded or an aggregate: a dashboard that loaded a table to count it is the page
// that gets slower as the app succeeds.

import { db, type Friendship, type Post } from '@social-media-clone/db';

export type { Friendship, Post };

/** Newest posts the activity chart and the table are cut from — before visibility filters them. */
export const RECENT_POSTS = 200;

/** Ceiling on the likes one read returns: 14 days over 200 posts, far above the seeded graph. */
const LIKES_MAX = 5000;

/** Ceiling on one author lookup: a table shows a handful, the window names at most RECENT_POSTS. */
const AUTHORS_MAX = RECENT_POSTS;

/** Posts the viewer wrote and has not deleted — one `count`, never a page. */
export const ownPostCount = (authorId: string): Promise<number> =>
  db.posts.where({ authorId, deletedAt: null }).count();

/**
 * Likes on those posts, summed from the denormalised `likeCount` each one keeps — one statement.
 * `sum` answers decimal TEXT (never a float) and `null` for no rows, which is zero likes here.
 */
export const likesOnOwnPosts = async (authorId: string): Promise<number> => {
  const total = await db.posts.where({ authorId, deletedAt: null }).sum('likeCount');
  return total === null ? 0 : Number(total);
};

/**
 * The viewer's friendships by status, in each direction: two grouped counts, because who asked is
 * part of the fact — "asked you" and "you asked" are different numbers.
 */
export const friendshipCounts = async (
  userId: string,
): Promise<{
  readonly asked: ReadonlyMap<Friendship['status'], number>;
  readonly askedOf: ReadonlyMap<Friendship['status'], number>;
}> => {
  const [asked, askedOf] = await Promise.all([
    db.friendships.where({ requesterId: userId }).countBy('status'),
    db.friendships.where({ addresseeId: userId }).countBy('status'),
  ]);
  return { asked, askedOf };
};

/** The newest posts, `(publishedAt desc, id)` — the feed's own total order, bounded. */
export const recentPosts = (): Promise<readonly Post[]> =>
  db.posts
    .where({ deletedAt: null })
    .orderBy('publishedAt', 'desc')
    .orderBy('id')
    .limit(RECENT_POSTS)
    .all();

/** When each like on these posts landed, since `from`: one `in (…)` read, never one per post. */
export const likeTimes = async (
  postIds: readonly string[],
  from: Date,
): Promise<readonly Date[]> => {
  if (postIds.length === 0) return [];
  const rows = await db.likes
    .andWhere('postId', 'in', [...new Set(postIds)])
    .andWhere('createdAt', 'gte', from)
    .select({ createdAt: true })
    .limit(LIKES_MAX)
    .all();
  return rows.map((row) => row.createdAt);
};

/** The handles of the authors a table names, keyed by id — the ids it holds, never "some users". */
export const handlesByIds = async (
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.users
    .andWhere('id', 'in', unique)
    .limit(Math.min(unique.length, AUTHORS_MAX))
    .all();
  return new Map(rows.map((user) => [user.id, user.handle]));
};
