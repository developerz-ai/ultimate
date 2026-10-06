// The dashboard's read model: the viewer's own figures, their friendships by state, and the
// activity on the posts they can see. Built here rather than in the page so the shape the UI
// renders is testable without a renderer, and so the page stays free of `db`.
//
// What the viewer can see is `canSeePost` — the feed's own rule, asked per row — never a `where`
// clause here: a second, weaker copy of that rule would drift the first time either changed.

import type { Actor } from '../../shared/actor';
import { canSeePost } from '../../shared/visibility';
import {
  friendshipCounts,
  handlesByIds,
  likesOnOwnPosts,
  likeTimes,
  ownPostCount,
  type Post,
  recentPosts,
} from './repo';

/** UTC days the activity chart spans, oldest first. */
export const ACTIVITY_DAYS = 14;

/** Rows the most-liked table shows. */
export const TOP_POSTS = 6;

const DAY_MS = 86_400_000;

export interface DashboardStats {
  readonly posts: number;
  readonly likes: number;
  readonly friends: number;
  /** Friend requests addressed to the viewer that nobody has answered yet. */
  readonly waiting: number;
}

/** The viewer's friendships, one count per state the friends screen lists them under. */
export interface Connections {
  readonly friends: number;
  readonly incoming: number;
  readonly outgoing: number;
  readonly declined: number;
}

export interface Activity {
  /** `MM-DD` per UTC day, oldest first — data, not prose, so ISO and never a locale format. */
  readonly keys: readonly string[];
  readonly posts: readonly number[];
  readonly likes: readonly number[];
}

export interface TopPost {
  readonly id: string;
  readonly body: string;
  readonly authorHandle: string;
  readonly likes: number;
  readonly comments: number;
  /** ISO text: a `Date` cannot cross the route's data seam. */
  readonly publishedAt: string;
}

export interface DashboardScreen {
  readonly stats: DashboardStats;
  readonly connections: Connections;
  readonly activity: Activity;
  readonly top: readonly TopPost[];
  /** The instant every relative date on the page is measured from. */
  readonly now: string;
}

const dayStart = (at: Date): number =>
  Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

/** One bucket per UTC day ending on `end`'s, every day present: a quiet day is still a day. */
export function perDay(stamps: readonly Date[], end: Date, days: number): readonly number[] {
  const start = dayStart(end) - (days - 1) * DAY_MS;
  const counts = Array.from({ length: days }, () => 0);
  for (const at of stamps) {
    const index = Math.floor((at.getTime() - start) / DAY_MS);
    if (index >= 0 && index < days) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

export function dayKeys(end: Date, days: number): readonly string[] {
  const start = dayStart(end) - (days - 1) * DAY_MS;
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * DAY_MS).toISOString().slice(5, 10),
  );
}

const status = (counts: ReadonlyMap<string, number>, name: string): number => counts.get(name) ?? 0;

/**
 * Everything one signed-in person's dashboard shows. Seven statements, none per row: four
 * aggregates for the figures, the newest posts, the likes on the visible ones in the window, and
 * the handles of the authors the table names.
 *
 * The window ENDS on the newest post the viewer can see, not on today: a quiet network would
 * otherwise chart fourteen zeros and say nothing, and the range line says which days these are.
 */
export const dashboardScreen = async (viewer: Actor, now: Date): Promise<DashboardScreen> => {
  const [posts, likes, friendships, recent] = await Promise.all([
    ownPostCount(viewer.id),
    likesOnOwnPosts(viewer.id),
    friendshipCounts(viewer.id),
    recentPosts(),
  ]);
  const visible: readonly Post[] = recent.filter((post) => canSeePost(viewer, post));
  const end = visible[0]?.publishedAt ?? now;
  const from = new Date(dayStart(end) - (ACTIVITY_DAYS - 1) * DAY_MS);
  const top = [...visible]
    .sort(
      (left, right) => right.likeCount - left.likeCount || right.commentCount - left.commentCount,
    )
    .slice(0, TOP_POSTS);
  const [likedAt, handles] = await Promise.all([
    likeTimes(
      // Only a post somebody liked can have a like in the window.
      visible.filter((post) => post.likeCount > 0).map((post) => post.id),
      from,
    ),
    handlesByIds(top.map((post) => post.authorId)),
  ]);

  const accepted = status(friendships.asked, 'accepted') + status(friendships.askedOf, 'accepted');
  const incoming = status(friendships.askedOf, 'pending');
  return {
    stats: { posts, likes, friends: accepted, waiting: incoming },
    connections: {
      friends: accepted,
      incoming,
      outgoing: status(friendships.asked, 'pending'),
      declined: status(friendships.asked, 'declined') + status(friendships.askedOf, 'declined'),
    },
    activity: {
      keys: dayKeys(end, ACTIVITY_DAYS),
      posts: perDay(
        visible.map((post) => post.publishedAt),
        end,
        ACTIVITY_DAYS,
      ),
      likes: perDay(likedAt, end, ACTIVITY_DAYS),
    },
    top: top.map((post) => ({
      id: post.id,
      body: post.body,
      authorHandle: handles.get(post.authorId) ?? '',
      likes: post.likeCount,
      comments: post.commentCount,
      publishedAt: post.publishedAt.toISOString(),
    })),
    now: now.toISOString(),
  };
};
