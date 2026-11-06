/**
 * Every post's like count, as a MATERIALIZED view: Postgres derives the rows from `likes`, the
 * `posts.like-totals` job (`apps/web/app/posts/jobs/like-totals.ts`) recomputes them, and nothing
 * writes one (`X_ENTITY_VIEW_READ_ONLY`). A join an app would otherwise re-aggregate on every read
 * — a rollup is for a time window over append-mostly rows, a view for a result refreshed whole.
 */

import { entity, integer, uuid } from '@ultimat3/entity';

export const postLikeTotals = entity('post_like_totals', {
  view: {
    sql: 'select org_id, post_id, count(*)::integer as likes from likes group by org_id, post_id',
    materialized: true,
  },
  columns: {
    // The tenant column keeps the repository's predicate: a member reads their own org's totals.
    orgId: uuid().tenant(),
    // Unique, so the refresh runs `concurrently` and readers keep the old rows while it computes.
    postId: uuid().unique(),
    likes: integer(),
  },
  primaryKey: ['postId'],
});

export type PostLikeTotal = typeof postLikeTotals.$row;
