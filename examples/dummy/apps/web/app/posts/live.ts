/**
 * The posts feature's reads. `liveFeed` is `live: true`, so the feed is pushed a patch per change
 * over the socket instead of polling. It is NOT offline: the durable client store — `persist: true`
 * over OPFS SQLite — has not shipped, `As of 2026-08`, so a disconnected client keeps whatever the
 * in-memory store last held and nothing survives a reload. `publicPost` is a plain
 * cached read: the public blog does not need a socket.
 *
 * `t` comes from @ultimat3/query, not @ultimat3/schema: a query file imports one package.
 *
 * Every read is ordered and bounded. `live: true` requires it — an unbounded live query is a
 * memory leak that only shows up under load — and the others keep the shape so promoting one
 * later is a one-line change.
 *
 * Every order ends with a key that is unique in the row shape, and that is not decoration: the
 * live matcher computes a row's insertion position and decides whether a change moved it from
 * this `orderBy` list alone. `createdAt desc` by itself is a partial order, so two posts written
 * in the same millisecond can swap places between evaluations and a bounded page can drop or
 * repeat one at the boundary. `repo.ts` gets its tail key for free — @ultimat3/entity appends the
 * primary key to every plan — but `from()` builds the shape declared here, so it is written out.
 * Ascending, to match the direction the repo appends.
 */

import { tag } from '@postly/db';
import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { publicPostRead } from '@postly/web/shared/policies';
import { from, query, t } from '@ultimat3/query';
import type { PostSummary, PostView } from './entity';
import { feedRead, postRead } from './policy';
import type { ActivitySummary, PostWithComments, PublishedSlug } from './repo';
import * as repo from './repo';

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

/** The single post page. Comments come with it: one round trip, one cache entry, two tags. */
export const postById = query({
  input: t.object({ orgId: t.uuid, postId: t.uuid }),
  policy: postRead,
  cache: { tags: [tag.post, tag.comment], ttlMs: 60_000 },
  mcp: { expose: true, description: 'Read one post with its comments' },
  sql: ({ orgId, postId }) =>
    from<PostWithComments>('posts', () => repo.withComments(toOrgId(orgId), toPostId(postId)))
      .where({ orgId, id: postId })
      .orderBy('createdAt')
      .orderBy('id')
      .limit(1),
});

/**
 * The feed's activity badge: how many posts this org has published, not live and not bundled
 * with `liveFeed` — its own read, its own cache tag, so `app/feed/page.tsx` can stream it in a
 * `<Suspense>` boundary independently of the rows, which arrive over the socket and never through
 * this client.
 */
export const feedActivity = query({
  input: t.object({ orgId: t.uuid }),
  policy: feedRead,
  cache: { tags: [tag.post], ttlMs: 60_000 },
  mcp: { expose: true, description: 'How many posts this org has published' },
  sql: ({ orgId }) =>
    from<ActivitySummary>('posts', () => repo.activitySummary(toOrgId(orgId)))
      .where({ orgId })
      .orderBy('orgId')
      .limit(1),
});

/**
 * The public blog's reads. Anonymous by policy — `publicPostRead` is written down in
 * `shared/policies.ts` rather than being the absence of a rule. "Published only" is the `where`
 * below, not the policy: a policy owns the yes/no, a query owns the rows. `site/` reaches these
 * through the typed client, never by importing this file.
 */
export const publicPost = query({
  input: t.object({ slug: t.string }),
  policy: publicPostRead,
  cache: { tags: [tag.blog], ttlMs: 3_600_000 },
  mcp: { expose: true, description: 'Read one published post from the public blog' },
  sql: ({ slug }) =>
    from<PostView>('posts', () => repo.publishedBySlug(slug))
      .where({ slug, status: 'published' })
      .orderBy('publishedAt', 'desc')
      .orderBy('id')
      .limit(1),
});

/**
 * The public blog index. A `PostSummary`, not a slug: the index renders the same `<PostCard>` the
 * org feed does, and a card needs a title, an excerpt and a byline. `publicPostSlugs` below stays
 * what it is — the prerender enumeration — because a URL list and a page of cards are two reads
 * with two cache lifetimes, not one read used twice.
 */
export const publicPosts = query({
  input: t.object({ limit: t.number.int().min(1).max(50).default(20) }),
  policy: publicPostRead,
  cache: { tags: [tag.blog], ttlMs: 3_600_000 },
  mcp: { expose: true, description: 'List the published posts on the public blog' },
  sql: ({ limit }) =>
    from<PostSummary>('posts', () => repo.publishedPage(limit))
      .where({ status: 'published' })
      .orderBy('publishedAt', 'desc')
      .orderBy('id')
      .limit(limit),
});

/**
 * Feeds `prerender()` on the blog route: one row per page the build must emit. The tail key is
 * `slug`, not `id` — this projection has no `id` column to sort on, and `slug` is unique across
 * every org by invariant, which is the same property the public URL relies on.
 */
export const publicPostSlugs = query({
  input: t.object({}),
  policy: publicPostRead,
  cache: { tags: [tag.blog], ttlMs: 3_600_000 },
  sql: () =>
    from<PublishedSlug>('posts', repo.publishedSlugs)
      .where({ status: 'published' })
      .orderBy('publishedAt', 'desc')
      .orderBy('slug')
      .limit(1000),
});

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
