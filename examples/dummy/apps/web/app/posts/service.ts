/**
 * Post business logic. Registered as `ctx.posts` by the feature-slice convention, so an action,
 * a job, an MCP tool and the admin app all call the same functions with the same actor.
 */

import { memberOf } from '@postly/core';
import { excerptOf, type MemberId, type PostId, slugify } from '@postly/domain';
import { type Ctx, defineService } from '@ultimat3/core';
import { NotAMember } from '../../shared/errors';
import type { CommentView, CreatePostInput, PostView } from './entity';
import { PostNotFound } from './errors';
import type { PostRow } from './policy';
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

export const postsService = defineService('posts', (ctx: Ctx) => {
  /**
   * Postly's identity is the MEMBERSHIP, read off the same actor every policy reads
   * (`memberOf`, `@postly/core`) — never `ctx.actor.memberId`, which core's `Actor` does not
   * declare (`packages/core/src/actor.ts`). It was `undefined` in every row this service wrote,
   * which surfaced as `X_INVARIANT_VIOLATED: posts.authorId` rather than as a missing field.
   *
   * Resolved once, here: a service closes over the ctx it was built for, so the acting member
   * cannot change under it.
   */
  const member = memberOf(ctx.actor);

  /**
   * The author of anything this actor writes. Every caller is behind a policy that already
   * required a membership, so `null` here is broken wiring rather than a denial to re-decide —
   * and it is the same refusal `ctx.orgs` raises, from the same class.
   */
  const authorId = (): MemberId => {
    if (member === null) throw new NotAMember(ctx.actor.id);
    return member.memberId;
  };

  return {
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
        authorId: authorId(),
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
      await insertLike(ctx.actor.orgId, post.id as PostId, authorId());
      return recountLikes(ctx.actor.orgId, post.id as PostId);
    },

    async unlike(postId: PostId): Promise<PostView> {
      const post = await this.byId(postId); // same tenancy check, same reason
      await deleteLike(ctx.actor.orgId, post.id as PostId, authorId());
      return recountLikes(ctx.actor.orgId, post.id as PostId);
    },

    /** Comments are part of the post aggregate, so they live in this service, not a fourth feature. */
    async comment(postId: PostId, body: string): Promise<CommentView> {
      const post = await this.byId(postId); // tenancy check by construction
      return insertComment({
        orgId: ctx.actor.orgId,
        postId: post.id as PostId,
        authorId: authorId(),
        body,
      });
    },

    /** What the digest mails. Bounded and ordered, so a big org does not mail a book. */
    publishedSince,

    /**
     * The row `postPublish` decides about, loaded by `publishPost`'s `row:` loader BEFORE the
     * guard runs (`packages/action/src/invoke.ts` — `def.row(...)`, then `guard(...)`).
     *
     * That ordering is why the read is scoped to the ACTING member's org and not to the org the
     * input names: a read scoped to someone else's tenant is `X_TENANCY_ACTOR_MISMATCH` from the
     * entity layer, and an actor with no org at all is `X_TENANCY_ACTOR_ORG_REQUIRED` — both
     * raised before any policy could deny, so a foreign caller got a tenancy error where the
     * contract says `X_FORBIDDEN`. Answering `null` for a non-member, and reading only inside the
     * actor's own org, hands `postPublish` exactly what it is built to refuse: `row === null` is a
     * denial, and `input.orgId` is still compared against the member's own inside the rule.
     *
     * No `orgId` parameter, deliberately: there is no value a caller could pass that would widen
     * this read, so the scope is not something a call site can get wrong.
     */
    async authorship(postId: PostId): Promise<PostRow | null> {
      return member === null ? null : authorshipOf(member.orgId, postId);
    },
  };
});
