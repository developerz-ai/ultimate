import { type Post, posts } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { feedRead } from '../policy';
import * as repo from '../repo';

/**
 * The org's recent posts as whole ROWS — the `org-posts` channel's catch-up read (`channels.ts`).
 * `rows: posts.$schema` is what makes the answer a record envelope, so a client re-reading after a
 * `replay-gap` lands the rows in the page's store and every island showing one re-renders.
 */
export const orgPosts = query({
  input: t.object({ orgId: t.uuid }),
  policy: feedRead,
  rows: posts.$schema,
  sql: ({ orgId }) =>
    from<Post>('posts', () => repo.recentRows(toOrgId(orgId), 50))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(50),
});
