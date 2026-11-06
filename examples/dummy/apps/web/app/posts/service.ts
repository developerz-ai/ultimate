/**
 * Post business logic. Registered as `ctx.posts` by the feature-slice convention, so an action,
 * a job, an MCP tool and the admin app all call the same functions with the same actor.
 */

import { type Actor as Member, memberOf, NotAMember } from '@postly/core';
import type { PostReviewRun } from '@postly/db';
import {
  excerptOf,
  type MemberId,
  type OrgId,
  type PostId,
  slugify,
  orgId as toOrgId,
} from '@postly/domain';
import type { AgentTranscript } from '@ultimat3/ai';
import { defineService, isUltimateError, keyedFingerprint } from '@ultimat3/core';
import type { CommentView, CreatePostInput, DraftReview, PostView, ReviewView } from './entity';
import { PostNotFound, PostSlugTaken } from './errors';
import type { PostRow } from './policy';
import {
  authorshipOf,
  byId,
  bySlug,
  checkpointReviewRun,
  closeReviewRun,
  deleteLike,
  insertComment,
  insertDraft,
  insertLike,
  markPublished,
  markWithdrawn,
  publishedSince,
  recountLikes,
  reviewOf,
  reviewRunOf,
  startReviewRun,
  upsertReview,
} from './repo';

/** The purpose a review run's draft mark is keyed under — nothing else is fingerprinted by it. */
const REVIEW_DRAFT_PURPOSE = 'postly.review-run.draft';

/**
 * `(ctx)` with NO annotation, which is `defineService`'s own documented form and not a shortcut.
 *
 * A factory's parameter is `CtxFacts` — requestId, actor, locale, tz, clock, logger, signal — and
 * deliberately NOT `Ctx`. `Ctx extends CtxServices`, and this app augments `CtxServices` with
 * `posts` and `orgs`, so annotating `ctx: Ctx` here made the factory that BUILDS `ctx.posts`
 * require `ctx.posts` to already exist. It compiled for as long as `ServiceFactory` took a `Ctx`;
 * the moment it took the facts, the circularity became eight type errors — one for the parameter
 * and four more where `this` in the returned literal collapsed to `{}` behind it.
 *
 * Left inferred rather than re-annotated `CtxFacts`, because an annotation can drift from the
 * framework's signature a second time and a contextual type cannot.
 */
export const postsService = defineService('posts', (ctx) => {
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
   * The acting membership, or the refusal. Every caller is behind a policy that already required a
   * membership, so `null` here is broken wiring rather than a denial to re-decide — and it is the
   * same refusal `ctx.orgs` raises, from the same class.
   */
  const acting = (): Member => {
    if (member === null) throw new NotAMember(ctx.actor.id);
    return member;
  };

  /** The author of anything this actor writes. */
  const authorId = (): MemberId => acting().memberId;

  /**
   * The org every read and write below is scoped to. `ctx.actor.orgId` is `string | undefined` on
   * core's `Actor` — the framework cannot know an app requires a tenant — so it typechecked
   * nowhere an `OrgId` was wanted and, `undefined`, reached the entity layer as
   * `X_TENANCY_ACTOR_ORG_REQUIRED` instead of the membership refusal this app owns. The membership
   * projection is the one answer: `memberOf` already refused an actor without an org.
   */
  const tenantId = (): OrgId => acting().orgId;

  /**
   * The org of a caller with an org and NO membership — an org's API key on the `/v1` mount
   * (`app/runs/keys.ts`), which `postPublish` lets publish inside that org. `null` for a member,
   * whose every path above stays `acting()`'s, and for an actor with no org at all.
   */
  const keyOrg: OrgId | null =
    member === null && ctx.actor.orgId !== undefined && ctx.actor.orgId !== ''
      ? toOrgId(ctx.actor.orgId)
      : null;

  return {
    async byId(postId: PostId): Promise<PostView> {
      const post = await byId(tenantId(), postId);
      if (!post) throw new PostNotFound(postId);
      return post;
    },

    async bySlug(slug: string): Promise<PostView> {
      const post = await bySlug(tenantId(), slug);
      if (!post) throw new PostNotFound(slug);
      return post;
    },

    /** Excerpt and slug are derived, never accepted verbatim: both are load-bearing forever. */
    async createDraft(input: CreatePostInput): Promise<PostView> {
      // A caller's slug is normalised like a derived one: `My Post` is `my-post`, never a 422.
      const slug = slugify(input.slug ?? input.title);
      try {
        return await insertDraft({
          orgId: tenantId(),
          authorId: authorId(),
          slug,
          title: input.title,
          excerpt: excerptOf(input.body),
          body: input.body,
        });
      } catch (error) {
        // The id is generated, so the slug is the one unique a new draft can collide on.
        if (isUltimateError(error) && error.code === 'X_DB_UNIQUE_VIOLATION') {
          throw new PostSlugTaken(slug);
        }
        throw error;
      }
    },

    /**
     * Publishing is idempotent: a post that is already published keeps its original instant, so a
     * retried action or a replayed job never rewrites publication history.
     */
    async publish(postId: PostId): Promise<PostView> {
      if (keyOrg !== null) {
        // An org key: the member-free read, inside the key's own org, then the same write.
        const post = await this.inOrg(keyOrg, postId);
        if (!post) throw new PostNotFound(postId);
        if (post.status === 'published') return post;
        return markPublished(keyOrg, postId, ctx.now());
      }
      const post = await this.byId(postId);
      if (post.status === 'published') return post;
      return markPublished(tenantId(), postId, ctx.now());
    },

    /** Withdrawing is idempotent too: a post that is not published is answered as it stands. */
    async withdraw(postId: PostId): Promise<PostView> {
      const post = await this.byId(postId);
      if (post.status !== 'published') return post;
      return markWithdrawn(tenantId(), postId);
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
      await insertLike(tenantId(), post.id as PostId, authorId());
      return recountLikes(tenantId(), post.id as PostId);
    },

    async unlike(postId: PostId): Promise<PostView> {
      const post = await this.byId(postId); // same tenancy check, same reason
      await deleteLike(tenantId(), post.id as PostId, authorId());
      return recountLikes(tenantId(), post.id as PostId);
    },

    /** Comments are part of the post aggregate, so they live in this service, not a fourth feature. */
    async comment(postId: PostId, body: string): Promise<CommentView> {
      const post = await this.byId(postId); // tenancy check by construction
      return insertComment({
        orgId: tenantId(),
        postId: post.id as PostId,
        authorId: authorId(),
        body,
      });
    },

    /**
     * Keep a review of a post — the write `keepDraftReview` makes, on the post id IT was given. Made
     * FOR the acting member,
     * who is the asker on every path: a request's own member, or the member an `agentJob` run
     * re-resolved and acts for. Never a member the model names.
     */
    async recordReview(postId: PostId, review: DraftReview): Promise<ReviewView> {
      const post = await this.byId(postId); // tenancy check by construction
      return upsertReview({
        orgId: tenantId(),
        postId: post.id as PostId,
        verdict: review.verdict,
        notes: review.notes,
        reviewedBy: authorId(),
      });
    },

    /**
     * Open the post's review run, or pick up the one already open: its latest checkpoint, or `null`
     * to start from the top. A run opened for an older draft is started over — its transcript holds
     * the words the model was SENT, so resuming it would review a post that no longer reads so.
     */
    async openReviewRun(postId: PostId): Promise<AgentTranscript | null> {
      const post = await this.byId(postId); // tenancy check by construction
      const draft = keyedFingerprint({ title: post.title, body: post.body }, REVIEW_DRAFT_PURPOSE);
      const open = await reviewRunOf(tenantId(), post.id as PostId);
      if (open !== null && open.draft === draft) {
        // OPAQUE JSON as far as this app is concerned: `.continue()` screens it — signature,
        // agent, model, tools, tenant, then every block — before anything is sent.
        return open.checkpoint as unknown as AgentTranscript | null;
      }
      await startReviewRun({ orgId: tenantId(), postId: post.id as PostId, draft });
      return null;
    },

    /** `reviewDraft`'s `onCheckpoint`: the run so far, kept on the run `openReviewRun` opened. */
    async checkpointReview(postId: PostId, transcript: AgentTranscript): Promise<void> {
      // The handle is JSON by contract (`AgentTranscript`); the column is `json(t.json())`.
      const checkpoint = transcript as unknown as NonNullable<PostReviewRun['checkpoint']>;
      await checkpointReviewRun(tenantId(), postId, checkpoint);
    },

    /** The review is kept, so the run is over: the next request starts a new one. */
    async closeReviewRun(postId: PostId): Promise<void> {
      await closeReviewRun(tenantId(), postId);
    },

    /**
     * A post read inside a NAMED org, with no acting member required — what a delivery job reads
     * its event from, whose actor carries only the org it declared. The entity guard refuses an
     * org that is not the actor's own, so a request cannot reach another tenant through this.
     */
    async inOrg(orgId: OrgId, postId: PostId): Promise<PostView | null> {
      return byId(orgId, postId);
    },

    /** The post's latest review, or `null` before any was recorded. */
    async review(postId: PostId): Promise<ReviewView | null> {
      return reviewOf(tenantId(), postId);
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
     * this read, so the scope is not something a call site can get wrong. An org key reads inside
     * its OWN org for the same reason; `null` for anyone with neither.
     */
    async authorship(postId: PostId): Promise<PostRow | null> {
      const org = member?.orgId ?? keyOrg;
      return org === null ? null : authorshipOf(org, postId);
    },
  };
});
