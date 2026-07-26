/**
 * The posts feature's reads. `liveFeed` is subscribable and persisted (tier 3), so the feed
 * renders from the device's own copy when the network is gone. `postBySlug` is a plain cached
 * read — the public blog does not need a socket.
 */

import { db, tag } from '@postly/db';
import { can } from '@ultimat3/policy';
import { query } from '@ultimat3/query';
import { t } from '@ultimat3/schema';

export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  /** Tier 3: swaps the client result store to IndexedDB and makes the mutator queue durable. */
  persist: true,
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});

/** The single post page. Comments come with it: one round trip, one cache entry, two tags. */
export const postById = query({
  input: t.object({ postId: t.uuid }),
  policy: can('post:read'),
  cache: { tags: [tag.post, tag.comment], ttl: '1m' },
  mcp: { expose: true, description: 'Read one post with its comments' },
  sql: ({ postId }) =>
    db.posts
      .where({ id: postId })
      .with({ comments: db.comments.where({ postId }).orderBy('createdAt').limit(100) })
      .limit(1),
});

/**
 * The public blog's reads. Anonymous by policy — `post:read-public` is written down in
 * `shared/policies.ts` rather than being the absence of a rule, so a draft can never leak into a
 * prerendered page. `site/` reaches these through the typed client, never by importing this file.
 */
export const publicPost = query({
  input: t.object({ slug: t.string }),
  policy: can('post:read-public'),
  cache: { tags: [tag.blog], ttl: '1h' },
  mcp: { expose: true, description: 'Read one published post from the public blog' },
  sql: ({ slug }) => db.posts.where({ slug, status: 'published' }).limit(1),
});

/** Feeds `prerender()` on the blog route: one row per page the build must emit. */
export const publicPostSlugs = query({
  input: t.object({}),
  policy: can('post:read-public'),
  cache: { tags: [tag.blog], ttl: '1h' },
  sql: () =>
    db.posts
      .where({ status: 'published' })
      .select({ slug: true, updatedAt: true })
      .orderBy('publishedAt', 'desc')
      .limit(1000),
});

/**
 * Bounded and deterministic is a requirement for `live: true`; this one is not live, but keeping
 * the same shape means promoting it later is a one-line change.
 */
export const postBySlug = query({
  input: t.object({ orgId: t.uuid, slug: t.string }),
  policy: can('feed:read'),
  cache: { tags: [tag.post], ttl: '5m' },
  mcp: { expose: true, description: 'Read one published post by slug' },
  sql: ({ orgId, slug }) => db.posts.where({ orgId, slug, status: 'published' }).limit(1),
});
