// `liveFeed`, the posts slice's query — one primitive per file, the layout `x g` writes.
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

import { orgId as toOrgId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import type { PostSummary } from '../entity';
import { feedRead } from '../policy';
import * as repo from '../repo';

export const liveFeed = query({
  input: t.object({ orgId: t.uuid, limit: t.number.int().min(1).max(50).default(50) }),
  policy: feedRead,
  live: true,
  // The relation this read is patched from, said out loud: it lives inside `sql:` below, which no
  // generator can invoke without valid input, so `x db gen` reads THIS to emit
  // `alter table "posts" replica identity full` — without which logical replication carries no old
  // row on an UPDATE and `@ultimat3/realtime` can compute no patch. Machine-checked against the
  // resolved `shape.entity` on the first subscribe, so a stale name is X_QUERY_SUBSCRIBES_DRIFT.
  subscribes: ['posts'],
  sql: ({ orgId, limit }) =>
    // 'posts' — the entity's snake_case table, not the feature name: `from()` quotes the
    // identifier straight into the SQL text an agent reads back.
    from<PostSummary>('posts', () => repo.feedPage(toOrgId(orgId), limit))
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(limit),
});
