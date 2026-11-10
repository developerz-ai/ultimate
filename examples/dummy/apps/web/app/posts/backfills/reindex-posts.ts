/**
 * `reindexPosts`: rebuilds the post search index from the table — what an operator runs after
 * pointing `runtime.ts`'s `searchIndex` at a new engine, or after one lost data. `reindex()` is a
 * `backfill()`, so it inherits the checkpoints, the throttle and `x db backfill`. Each document is
 * versioned by `updatedAt`, so a pass racing a live edit can never put an older title back.
 */

import { db, posts } from '@postly/db';
import { assert, hasScope } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE } from '@ultimat3/entity';
import { reindex } from '@ultimat3/jobs';

export const reindexPosts = reindex({
  name: 'reindex-posts',
  entity: posts,
  // Every org's posts in one pass; each document keeps its own org (`tenant` below is the run's).
  tenant: 'none',
  source: ({ ctx }) => {
    assert(
      hasScope(ctx.actor, CROSS_TENANT_SCOPE),
      'reindex-posts: this pass spans every tenant and its actor holds no tenancy:cross',
      'x db backfill reindex-posts --write --json',
    );
    return db.posts;
  },
});
