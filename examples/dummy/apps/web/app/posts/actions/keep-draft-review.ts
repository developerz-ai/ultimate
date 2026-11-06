import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import type { AgentTranscript } from '@ultimat3/ai';
import { type Actor, stringField } from '@ultimat3/core';
import { ReviewView } from '../entity';
import { PostNotFound } from '../errors';
import { postReviewKeep } from '../policy';
import { reviewDraft } from './review-draft';

/** The turn a resumed run is handed: the transcript already holds the draft and every tool result. */
const RESUME = 'Your previous turn was interrupted. Carry on from the tool results above.';

/**
 * The review, from where the last attempt's checkpoint left it — or from the top when there is
 * none, or when the stored one is refused: a prompt bump, a model change or a rotated secret
 * invalidates a handle BY DESIGN (`X_AGENT_TRANSCRIPT_INVALID`), and a retried attempt must review
 * the draft rather than dead-letter on it.
 */
const resumeOrRun = async (
  input: { readonly postId: string; readonly orgId: string },
  stored: AgentTranscript | null,
  actor: Actor,
) => {
  if (stored === null) return reviewDraft.run(input, { actor });
  try {
    return await reviewDraft.continue(input, { transcript: stored, user: RESUME }, { actor });
  } catch (error) {
    if (stringField(error, 'code') !== 'X_AGENT_TRANSCRIPT_INVALID') throw error;
    return reviewDraft.run(input, { actor });
  }
};

/**
 * Review a draft AND keep the verdict: `reviewDraft` run as the caller, then the post's one review
 * upserted under the post id this action was given. The write's target is the code's, so nothing
 * in a draft can move it onto another post, and the write is IDEMPOTENT by the table's key
 * `(orgId, postId)` — a run the queue replays from the top writes the same row again rather than a
 * second review, the bar any write an `agentJob` makes has to clear.
 *
 * `postReviewKeep`: the author or an org admin, as publishing is, and only for themselves — the
 * member the review is FOR is the caller. No `mcp`: an agent asks with `draftReview` (`apps/web/mcp-tools.ts`).
 *
 * And RESUMABLE: the post's review run (`post_review_runs`) holds `reviewDraft`'s latest
 * checkpoint, so an attempt the queue retries after its worker died continues from the last turn
 * whose tool results landed. A worker lost DURING a tool batch re-asks that one turn, so its tools
 * may run again — the replay shrinks to one turn, and at-least-once still binds.
 */
export const keepDraftReview = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, memberId: t.uuid }),
  output: ReviewView,
  policy: postReviewKeep,
  // Closed: see `publishPost`.
  errors: [PostNotFound.code],
  // Loaded before the guard, as `publishPost` loads its row: the rule decides on authorship.
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  async handle({ input, ctx }) {
    const id = postId(input.postId);
    const stored = await ctx.posts.openReviewRun(id);
    const run = await resumeOrRun({ postId: input.postId, orgId: input.orgId }, stored, ctx.actor);
    const kept = await ctx.posts.recordReview(id, run.output);
    // After the review, never before: an attempt lost between the two resumes and writes it again.
    await ctx.posts.closeReviewRun(id);
    return kept;
  },
});
