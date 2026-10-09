// `postReview`, the posts slice's query — one primitive per file, the layout `x g` writes.
//
// The posts feature's reads. `liveFeed` is `live: true`, so the feed is pushed a patch per change
// over the socket instead of polling, and its rows are records of the page's store. `posts` is
// declared `persist: true` (`@postly/db`), so those records are on the device's disk too, per
// principal, and a reload offline still shows them. `publicPost` is a plain cached read: the
// public blog does not need a socket.
//
// `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.
//
// Every read is ordered and bounded. `live: true` requires it — an unbounded live query is a
// memory leak that only shows up under load — and the others keep the shape so promoting one
// later is a one-line change.
//
// Every order ends with a key that is unique in the row shape, and that is not decoration: the
// live matcher computes a row's insertion position and decides whether a change moved it from
// this `orderBy` list alone. `createdAt desc` by itself is a partial order, so two posts written
// in the same millisecond can swap places between evaluations and a bounded page can drop or
// repeat one at the boundary. `repo.ts` gets its tail key for free — @ultimat3/entity appends the
// primary key to every plan — but `from()` builds the shape declared here, so it is written out.
// Ascending, to match the direction the repo appends.

import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import type { ReviewView } from '../entity';
import { postRead } from '../policy';
import * as repo from '../repo';

/**
 * A post's latest review — what `keepDraftReview` kept, which is the only place a queued
 * `reviewDraftLater` run's verdict lands. Not cached: a review that just landed has to be the one
 * read back, and a tag for it would be a second invalidation to keep in step with the upsert.
 */
export const postReview = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid }),
  policy: postRead,
  mcp: { expose: true, description: 'Read the latest review of a post' },
  sql: ({ orgId, postId }) =>
    from<ReviewView>('post_reviews', () => repo.reviewRows(toOrgId(orgId), toPostId(postId)))
      .where({ orgId, postId })
      .orderBy('postId')
      .limit(1),
});
