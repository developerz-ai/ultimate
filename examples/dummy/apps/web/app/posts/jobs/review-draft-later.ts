import { memberId, orgId } from '@postly/domain';
import { agentJob } from '@ultimat3/ai';
import { postlyActor } from '../../../shared/actor';
import { keepDraftReview } from '../actions/keep-draft-review';

/**
 * `keepDraftReview`, queued: the review an author asks for and reads back later from `postReview`.
 * `agentJob()` is a factory over `job()`, and it wraps ANY action — here the one that runs the
 * agent and keeps its answer, because a queued run's own output is not stored. Declared beside
 * what it wraps (it reads it at module scope) and registered in `api/index.ts`'s `jobs` list
 * through this module.
 *
 * `actor`: a worker's own actor is nobody, so the run re-reads the member its input names, inside
 * the org `tenant` declared, on EVERY attempt — a member who left, or lost the right, is refused
 * by the same rule a request meets rather than trusted from the payload that queued it.
 */
export const reviewDraftLater = agentJob(keepDraftReview, {
  name: 'posts.review',
  tenant: (input) => input.orgId,
  retry: { attempts: 3, backoff: 'exponential' },
  // One queued review per post and member; a second request while one is live is the same run.
  idempotencyKey: (input) => `review:${input.postId}:${input.memberId}`,
  actor: async ({ input, ctx }) =>
    postlyActor(await ctx.orgs.actingFor(orgId(input.orgId), memberId(input.memberId))),
});
