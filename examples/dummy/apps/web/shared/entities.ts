/**
 * The row → props mapping both surfaces need. Kept in `shared/` because the blog and the feed
 * render the same card from two different queries, and a second mapping is a second bug.
 */

import type { PostStatus } from '@postly/domain';
import type { PostCardPost } from '@postly/ui';

export type RenderablePost = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly status: PostStatus;
  readonly likeCount: number;
  readonly publishedAt: Date | null;
  readonly authorName: string;
};

export const toCardPost = (post: RenderablePost): PostCardPost => ({
  id: post.id,
  slug: post.slug,
  title: post.title,
  excerpt: post.excerpt,
  status: post.status,
  likeCount: post.likeCount,
  publishedAt: post.publishedAt,
  authorName: post.authorName,
});

export const blogHref = (post: { slug: string }): string => `/blog/${post.slug}`;
export const postHref = (post: { id: string }): string => `/posts/${post.id}`;
