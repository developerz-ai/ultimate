import { tag } from '@postly/db';
import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { postRead } from '../policy';
import type { PostWithComments } from '../repo';
import * as repo from '../repo';

/** The single post page. Comments come with it: one round trip, one cache entry, two tags. */
export const postById = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid }),
  policy: postRead,
  cache: { tags: [tag.post, tag.comment], ttlMs: 60_000 },
  mcp: { expose: true, description: 'Read one post with its comments' },
  sql: ({ orgId, postId }) =>
    // Ordered by `id` alone: the row is ONE post, found by its key, and a `PostView` carries no
    // `createdAt`. The `orderBy('createdAt')` that stood here sorted on a column the rows lack, and
    // `from()` refuses that now (X_QUERY_COLUMN_UNSELECTED) — which took `/posts/{id}` down.
    from<PostWithComments>('posts', () => repo.withComments(toOrgId(orgId), toPostId(postId)))
      .where({ orgId, id: postId })
      .orderBy('id')
      .limit(1),
});
