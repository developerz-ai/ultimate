// `postRevisions`, the posts slice's query — one primitive per file, the layout `x g` writes.
//
// A post's recorded history: `posts` declares `history: { retain }`, so every write to a post is a
// `posts_history` row its trigger keeps, and this is the read of it — `history()`, through the repo.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.

import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { PostRevision } from '../entity';
import { postRead } from '../policy';
import * as repo from '../repo';

/**
 * The newest fifty versions of one post. `postRead`, the post's own read rule: whoever may read the
 * post may read what it said before — drafts included, so its history stays inside the org as the
 * draft does. Not cached: an edit that just landed is the revision a reader came to see.
 */
export const postRevisions = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid }),
  policy: postRead,
  // The published row: OpenAPI, the MCP tool's `outputSchema` and the typed client read it from
  // here. Not an entity's schema, so the answer stays bare rows rather than a record envelope.
  rows: PostRevision,
  mcp: { expose: true, description: 'List the recorded revisions of a post, newest first' },
  sql: ({ orgId, postId }) =>
    from<PostRevision>('posts_history', () => repo.revisionsOf(toOrgId(orgId), toPostId(postId)))
      .where({ orgId, postId })
      .orderBy('version', 'desc')
      .limit(repo.REVISIONS_SHOWN),
});
