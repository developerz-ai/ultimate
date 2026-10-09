// `postRecord`, the posts slice's query — one primitive per file, the layout `x g` writes.
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

import { memberOf, NotAMember } from '@postly/core';
import { type Post, posts } from '@postly/db';
import { type MemberId, orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { postRead } from '../policy';
import * as repo from '../repo';

/**
 * The member reading, for a read whose answer is theirs alone. `postRead` has already required a
 * membership, so `null` is broken wiring — refused the way `ctx.posts` refuses it, never read as
 * "likes nothing".
 */
const readerOf = (actor: Parameters<typeof memberOf>[0]): MemberId => {
  const member = memberOf(actor);
  if (member === null) throw new NotAMember(actor?.id ?? '');
  return member.memberId;
};

/**
 * One post as its whole ROW, the record `useRecord('posts', id)` reads — how the like islands on
 * `/posts/{id}` seed the store before a channel frame has anything to say about it. The row carries
 * the reader's own `likedByMe` beside its columns (`repo.recordById`): the like twin reads it, and
 * without it a member's repeat like painted +1 and dropped back. `from<Post>` and not the wider
 * row: `rows:` is the entity's schema, and the flag is not one of its columns.
 */
export const postRecord = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid }),
  policy: postRead,
  rows: posts.$schema,
  sql: ({ orgId, postId }, ctx) =>
    from<Post>('posts', () =>
      repo.recordById(toOrgId(orgId), toPostId(postId), readerOf(ctx.actor)),
    )
      .where({ orgId, id: postId })
      .orderBy('id')
      .limit(1),
});
