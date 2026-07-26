/**
 * The posts feature's view schemas. The table lives in `@postly/db` because admin and the worker
 * need it too; what a *post looks like on the wire* is this feature's business, so it lives here.
 */

import { EXCERPT_MAX, POST_STATUSES, SLUG_MAX, TITLE_MAX } from '@postly/domain';
import { t } from '@ultimat3/schema';

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
});

export type PostView = typeof PostView.infer;

/** The feed row: same post, minus the body, because 50 bodies is not a feed. */
export const PostSummary = PostView.omit('body');

export type PostSummary = typeof PostSummary.infer;

export const CommentView = t.object({
  id: t.uuid,
  postId: t.uuid,
  authorId: t.uuid,
  body: t.string,
  createdAt: t.date,
});

export type CommentView = typeof CommentView.infer;

export const CreatePostInput = t.object({
  title: t.string.max(TITLE_MAX),
  body: t.string.min(1),
  /** Optional: derived from the title when absent, because a slug is a URL forever. */
  slug: t.string.max(SLUG_MAX).optional(),
});

export type CreatePostInput = typeof CreatePostInput.infer;
