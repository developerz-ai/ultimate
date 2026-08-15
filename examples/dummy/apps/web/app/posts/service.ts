/**
 * Post business logic. Registered as `ctx.posts` by the feature-slice convention, so an action,
 * a job, an MCP tool and the admin app all call the same functions with the same actor.
 */

import { excerptOf, type PostId, slugify } from '@postly/domain';
import { type Ctx, defineService } from '@ultimat3/core';
import type { CommentView, CreatePostInput, PostView } from './entity';
import { PostNotFound } from './errors';
import {
  authorshipOf,
  byId,
  bySlug,
  deleteLike,
  insertComment,
  insertDraft,
  insertLike,
  markPublished,
  publishedSince,
  recountLikes,
} from './repo';

export const postsService = defineService('posts', (ctx: Ctx) => ({
  async byId(postId: PostId): Promise<PostView> {
    const post = await byId(ctx.actor.orgId, postId);
    if (!post) throw new PostNotFound(postId);
    return post;
  },

  async bySlug(slug: string): Promise<PostView> {
    const post = await bySlug(ctx.actor.orgId, slug);
    if (!post) throw new PostNotFound(slug);
    return post;
  },

  /** Excerpt and slug are derived, never accepted verbatim: both are load-bearing forever. */
  async createDraft(input: CreatePostInput): Promise<PostView> {
    return insertDraft({
      orgId: ctx.actor.orgId,
      authorId: ctx.actor.memberId,
      slug: input.slug ?? slugify(input.title),
      title: input.title,
      excerpt: excerptOf(input.body),
      body: input.body,
    });
  },

  /**
   * Publishing is idempotent: a post that is already published keeps its original instant, so a
   * retried action or a replayed job never rewrites publication history.
   */
  async publish(postId: PostId): Promise<PostView> {
    const post = await this.byId(postId);
    if (post.status === 'published') return post;
    return markPublished(ctx.actor.orgId, postId, ctx.now());
  },

  /**
   * The server half of `likePost`. Returns the authoritative row, which is what the client
   * rebases its optimistic count onto.
   *
   * The `byId` first is the tenancy check, and it is load-bearing: `insertLike` trusts the three
   * ids it is handed, so a caller pairing its own authorised `orgId` with another org's `postId`
   * used to write a `likes` row pointing across tenants — and `recountLikes`, scoped properly,
   * then matched no post and updated nothing. A write that silently does nothing is a worse bug
   * than a denial, so a foreign post id has to be `X_POST_NOT_FOUND` before anything is written.
   */
  async like(postId: PostId): Promise<PostView> {
    const post = await this.byId(postId);
    await insertLike(ctx.actor.orgId, post.id as PostId, ctx.actor.memberId);
    return recountLikes(ctx.actor.orgId, post.id as PostId);
  },

  async unlike(postId: PostId): Promise<PostView> {
    const post = await this.byId(postId); // same tenancy check, same reason
    await deleteLike(ctx.actor.orgId, post.id as PostId, ctx.actor.memberId);
    return recountLikes(ctx.actor.orgId, post.id as PostId);
  },

  /** Comments are part of the post aggregate, so they live in this service, not a fourth feature. */
  async comment(postId: PostId, body: string): Promise<CommentView> {
    const post = await this.byId(postId); // tenancy check by construction
    return insertComment({
      orgId: ctx.actor.orgId,
      postId: post.id as PostId,
      authorId: ctx.actor.memberId,
      body,
    });
  },

  /** What the digest mails. Bounded and ordered, so a big org does not mail a book. */
  publishedSince,

  /**
   * The row `postPublish` decides about, loaded by `publishPost`'s `row:` loader before the guard.
   * Two columns, scoped to the org the caller named — the rule denies a null row exactly as it
   * denies a row from another org, so the scope bounds the read without deciding anything, and an
   * unscoped read of a tenant-columned entity is `X_TENANCY_UNSCOPED` with no way around it.
   */
  authorship: authorshipOf,
}));
