// A post. `audience` is the only thing on the row that decides who may read it; the rest of the
// visibility rule is relational (friendship, blocks) and lives in the policy, because a column
// cannot express "a friend of the author".

import { AUDIENCES, BODY_MAX } from '@social-media-clone/domain';
import { entity, enumerated, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    authorId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    body: text({ max: BODY_MAX }),
    audience: enumerated(AUDIENCES).default('public'),
    /**
     * Denormalised so the feed query stays bounded and deterministic — a feed that counts likes
     * per row is a feed that gets slower as it succeeds. Owned by exactly one mutator each, which
     * RECOUNTS from the source table rather than incrementing: an incremented counter drifts the
     * moment an offline mutation is replayed, and replay is the normal case here, not the edge.
     */
    likeCount: integer().default(0),
    commentCount: integer().default(0),
    mediaCount: integer().default(0),
    publishedAt: timestamp().defaultNow(),
    deletedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: (c) => [
    invariant('post_body_present', c.body.trimmed().minLength(1)),
    invariant('post_like_count_non_negative', c.likeCount.atLeast(0)),
    invariant('post_comment_count_non_negative', c.commentCount.atLeast(0)),
    invariant('post_media_count_non_negative', c.mediaCount.atLeast(0)),
  ],
  indexes: [
    /**
     * The author's profile timeline as it is read (`postsByAuthor`, `site/u/repo.ts`): live rows,
     * `publishedAt desc` then `id asc`. Partial on `deletedAt` like the feed's, so the dashboard's
     * per-author count and sum (`dashboard/repo.ts`) are bounded by `authorId` rather than walking
     * the feed index — on a small table the planner preferred that walk over a full-table index.
     */
    {
      on: ['authorId', 'publishedAt', 'id'],
      orders: [null, 'desc', 'asc'],
      where: (c) => c.deletedAt.isNull(),
    },
    /**
     * The public feed's exact access path. Partial on the two things every read of it asserts, so
     * the index holds only rows the query can actually return.
     */
    {
      on: ['publishedAt'],
      order: 'desc',
      where: (c) => c.audience.eq('public'),
    },
    /**
     * The feed page as it is read (`feedPage`, `site/feed/repo.ts`): live rows, `publishedAt desc`
     * then `id asc` — the tiebreak a live matcher needs. One direction per key, because the order
     * is mixed and `order:` can only say one. The plan sweep found the bounded read sorting every
     * live post (`X_QUERY_SORT_UNSERVED`, /dashboard).
     */
    {
      on: ['publishedAt', 'id'],
      orders: ['desc', 'asc'],
      where: (c) => c.deletedAt.isNull(),
    },
    /**
     * The same page narrowed to one audience (/feed). `audience` is a bound parameter, so the
     * literal-predicate index above serves no generic plan; equality first, then the page's order.
     */
    {
      on: ['audience', 'publishedAt', 'id'],
      orders: [null, 'desc', 'asc'],
      where: (c) => c.deletedAt.isNull(),
    },
  ],
});

export type Post = typeof posts.$row;
