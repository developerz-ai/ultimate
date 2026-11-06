// `postLikesByDay`, the posts slice's query — one primitive per file, the layout `x g` writes.
//
// A post's likes per day, in the READER's zone: `series` buckets with a three-argument
// `date_trunc` in Postgres and the same rule in memory, so a like at 23:30 UTC is tomorrow's in
// Tokyo. The zone is input, from the curated list settings offers; the series checks it again.

import { db } from '@postly/db';
import { SUPPORTED_ZONES } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { postRead } from '../policy';

/** One day that holds likes. A day with none is absent: the chart's range is the client's. */
export interface LikesOnDay {
  readonly orgId: string;
  readonly postId: string;
  /** Local midnight in `timeZone`, as an instant. */
  readonly day: Date;
  readonly likes: number;
}

/** The widest window one read answers: a quarter of days, the chart's own longest range. */
export const LIKES_BY_DAY_MAX = 92;

export const postLikesByDay = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid, timeZone: t.enumerated(...SUPPORTED_ZONES) }),
  policy: postRead,
  mcp: { expose: true, description: 'Count a post’s likes per day in a given IANA time zone' },
  sql: ({ orgId, postId, timeZone }) =>
    from<LikesOnDay>('likes', async () =>
      (
        await db.likes
          .where({ orgId, postId })
          .series({ on: 'createdAt', unit: 'day', timeZone, value: 'count' })
      ).map((point) => ({ orgId, postId, day: point.bucket, likes: point.value })),
    )
      .where({ orgId, postId })
      .orderBy('day', 'desc')
      .limit(LIKES_BY_DAY_MAX),
});
