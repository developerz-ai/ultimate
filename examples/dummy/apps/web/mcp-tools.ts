// Postly's MCP server with the tools only `apps/web` can declare: a `jobTool()` runs one of the
// app's jobs, and `@postly/mcp` may not import a job (`X_BOUNDARY_PACKAGE_TO_APP`). So the app
// builds them here and hands them to `postlyMcp({ tools })` — one catalog, one set of checks.

import { jobTool, postlyMcp } from '@postly/mcp';
import { t } from '@ultimat3/schema';
import { reviewDraftLater } from './app/posts/jobs/review-draft-later';
import { postReview } from './app/posts/queries/post-review';

/**
 * A review of the caller's draft, as ONE long tool: the job is queued at once, and the answer is
 * `postReview`'s row read as the caller — or `{ status: 'running', poll }` naming `job_status`.
 *
 * `inlineMs: 0`: a review is a model run, tens of seconds, never inside a client's wait — the poll
 * is the answer. The member is the CALLER's, read off the request (`jobInput`), never a field an
 * agent fills in: the job runs as the member its input names. `post:publish` is the right the
 * review is kept under (`postReviewKeep`), which the queued run re-checks on the row it loads.
 */
const draftReview = jobTool({
  job: reviewDraftLater,
  description:
    'Review your draft and keep the verdict; read it back from the answer or job_status.',
  policy: 'post:publish',
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  jobInput: async (input, ctx) => ({ ...input, memberId: (await ctx.orgs.me()).id }),
  result: postReview,
  inlineMs: 0,
});

/** Built on call, as `postlyMcp` is: after `apps/web/api` has registered what it projects. */
export const webMcp = () => postlyMcp({ tools: { draftReview } });
