// `requestDraftReview`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { reviewDraftLater } from '../jobs/review-draft-later';
import { postPublish } from '../policy';

/**
 * Ask for a kept review in the background — the author's or an org admin's right, as publishing
 * is (`postPublish`, on the row loaded before the guard). The member is the caller's own, read off
 * the actor — never a field of the input — and the run is enqueued in this request's transaction.
 */
export const requestDraftReview = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: t.object({ jobId: t.string }),
  policy: postPublish,
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  mcp: { expose: true, description: 'Queue a review of your draft; read it back with postReview' },
  async handle({ input, ctx }) {
    const me = await ctx.orgs.me();
    const queued = await reviewDraftLater.enqueue({ ...input, memberId: me.id });
    return { jobId: queued.id };
  },
});
