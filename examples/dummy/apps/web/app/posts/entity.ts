/**
 * The posts feature's view schemas. The table lives in `@postly/db` because admin and the worker
 * need it too; what a *post looks like on the wire* is this feature's business, so it lives here.
 *
 * `t` comes from @ultimat3/schema here, not from a primitive package: this file declares no
 * primitive, so schema *is* its one import. Every primitive package re-exports the same object.
 */

import type { Post } from '@postly/db';
import { EXCERPT_MAX, POST_STATUSES, SLUG_MAX, TITLE_MAX } from '@postly/domain';
import { type Infer, t } from '@ultimat3/schema';

/**
 * Hop 4 of the type chain (docs/architecture/05-type-chain.md): every field below except
 * `authorName` must still name a real column on `posts`. `authorName` has no column of its own —
 * it comes from the `author` relation `repo.ts` preloads — so it is added back, not picked. A
 * column renamed or dropped in `packages/db/src/schema/posts.ts` fails to compile on the object
 * literal below, instead of surfacing three hops downstream as a field that silently arrives
 * `undefined`.
 */
type PostViewKeys = Exclude<keyof Post, 'createdAt' | 'updatedAt'> | 'authorName';

/** The output of every post action and query. Drives OpenAPI, the MCP tool, and the typed client. */
export const PostView = t.object({
  id: t.uuid,
  orgId: t.uuid,
  slug: t.string.max(SLUG_MAX),
  title: t.string.max(TITLE_MAX),
  excerpt: t.string.max(EXCERPT_MAX),
  body: t.string,
  coverUrl: t.nullable(t.url),
  status: t.enumerated(...POST_STATUSES),
  likeCount: t.number.int().min(0),
  /** UTC instant. Formatting is the edge's job, with the viewer's zone. */
  publishedAt: t.nullable(t.date),
  authorId: t.uuid,
  authorName: t.string,
} satisfies Record<PostViewKeys, unknown>);

export type PostView = Infer<typeof PostView>;

/**
 * The feed row: same post, minus the body, because 50 bodies is not a feed — plus `createdAt`,
 * which `PostView` deliberately omits and this row cannot.
 *
 * `liveFeed` orders by `createdAt desc, id`, and **a live query's rows have to carry the key they
 * are ordered by**. Without it the incremental matcher compares the change row's real `createdAt`
 * against nothing on the row the client holds, cannot place the row, and re-reads the whole window
 * on every change — the same rule `assertSeekable` already applies to a cursor's sort key, now
 * applied to the live window (#230). It is also the honest shape: a client handed a feed sorted by
 * creation time can neither re-sort nor resume without the value it was sorted on.
 */
export const PostSummary = PostView.omit('body').extend({ createdAt: t.date });

export type PostSummary = Infer<typeof PostSummary>;

/**
 * The `author` relation, as this feature reads it. `preload('author')` attaches the related row as
 * `unknown` on purpose — the other side is parsed by whoever needs it, never asserted into shape by
 * the reader — so the one field the view carries is narrowed here, where every other shape lives.
 */
export const PostAuthor = t.object({ name: t.string });

export type PostAuthor = Infer<typeof PostAuthor>;

export const CommentView = t.object({
  id: t.uuid,
  postId: t.uuid,
  authorId: t.uuid,
  body: t.string,
  createdAt: t.date,
});

export type CommentView = Infer<typeof CommentView>;

export const CreatePostInput = t.object({
  title: t.string.max(TITLE_MAX),
  body: t.string.min(1),
  /** Optional: derived from the title when absent, because a slug is a URL forever. */
  slug: t.string.max(SLUG_MAX).optional(),
});

export type CreatePostInput = Infer<typeof CreatePostInput>;
