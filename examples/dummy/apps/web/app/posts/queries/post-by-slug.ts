// `postBySlug`, the posts slice's query — one primitive per file, the layout `x g` writes.
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

import { tag } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import type { PostView } from '../entity';
import { feedRead } from '../policy';
import * as repo from '../repo';

/** The signed-in read of a published post by slug — same row, tenant-scoped, different policy. */
export const postBySlug = query({
  input: t.object({ orgId: t.uuid, slug: t.string }),
  policy: feedRead,
  cache: { tags: [tag.post], ttlMs: 300_000 },
  mcp: { expose: true, description: 'Read one published post by slug' },
  sql: ({ orgId, slug }) =>
    from<PostView>('posts', () => repo.publishedBySlugInOrg(toOrgId(orgId), slug))
      .where({ orgId, slug, status: 'published' })
      .orderBy('publishedAt', 'desc')
      .orderBy('id')
      .limit(1),
});
