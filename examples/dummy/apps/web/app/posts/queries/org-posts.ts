import { type Post, posts } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { feedRead } from '../policy';
import * as repo from '../repo';

/** The read's whole listing: the org's newest posts, never more. */
export const ORG_POSTS_MAX = 50;

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
    from<Post>('posts', (window) => repo.recentWindow(toOrgId(orgId), window))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(ORG_POSTS_MAX),
});
