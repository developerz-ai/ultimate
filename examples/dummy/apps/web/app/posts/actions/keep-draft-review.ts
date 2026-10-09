import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { ReviewView } from '../entity';
import { postReviewKeep } from '../policy';
import { reviewDraft } from './review-draft';

/**
 * Review a draft AND keep the verdict: `reviewDraft` run as the caller, then the post's one review
 * upserted under the post id this action was given. The write's target is the code's, so nothing
 * in a draft can move it onto another post, and the write is IDEMPOTENT by the table's key
 * `(orgId, postId)` — a run the queue replays from the top writes the same row again rather than a
 * second review, the bar any write an `agentJob` makes has to clear.
 *
 * `postReviewKeep`: the author or an org admin, as publishing is, and only for themselves — the
 * member the review is FOR is the caller. No `mcp`: an agent asks with `requestDraftReview`.
 */
export const keepDraftReview = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, memberId: t.uuid }),
  output: ReviewView,
  policy: postReviewKeep,
  // Loaded before the guard, as `publishPost` loads its row: the rule decides on authorship.
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  async handle({ input, ctx }) {
    const review = await reviewDraft.as(ctx.actor, { postId: input.postId, orgId: input.orgId });
    return ctx.posts.recordReview(postId(input.postId), review);
  },
});
