/**
 * Likes per day across Postly, in UTC — the rollup `posts.daily-likes` (`apps/web/app/posts/jobs/
 * daily-likes.ts`) keeps current. The app's own table, because which dimensions a report has is
 * business: this one has none but the day. Not tenant-scoped: it is the operator's number, and no
 * org's row is in it, only a count.
 */

import { entity, integer, timestamp } from '@ultimat3/entity';

export const dailyLikes = entity('daily_likes', {
  columns: {
    /** The bucket's first instant: midnight UTC. The rollup writes `series({ unit: 'day' })`'s. */
    day: timestamp(),
    likes: integer(),
  },
  // The rollup's `key`: one row per day, which is what makes a re-run an update and not a second row.
  primaryKey: ['day'],
});

export type DailyLikes = typeof dailyLikes.$row;
