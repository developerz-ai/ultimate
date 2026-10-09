// `summarizePosts`, the posts slice's `hive()` action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { t } from '@ultimat3/action';
import { hive } from '@ultimat3/ai';
import { postRead } from '../policy';
import { summarize } from './summarize';

/** How many posts one `summarizePosts` call may fan out over: a page of the feed, never a backlog. */
export const SUMMARIZE_POSTS_MAX = 20;

/**
 * The feed's "catch me up": many posts summarised in one call. `hive()` is the fan-out as an
 * action — each member is a `summarize` call with that action's own policy, input parse, cache and
 * budget, so a post another org owns fails as ITS member (`X_FORBIDDEN`) and never as the batch.
 *
 * `split` derives every member from the input alone, and the org it carries is the one `postRead`
 * already decided on. `'collect'`: one unreadable post should not cost the reader the other
 * nineteen summaries. A backlog of thousands is a `backfill()`, not a longer list here.
 */
export const summarizePosts = hive({
  input: t.object({
    orgId: t.uuid,
    postIds: t.array(t.uuid, { min: 1, max: SUMMARIZE_POSTS_MAX }),
  }),
  member: summarize,
  split: ({ input }) => input.postIds.map((id) => ({ postId: id, orgId: input.orgId })),
  concurrency: 4,
  onMemberError: 'collect',
  // The whole fan-out's ceiling: every member's `tokensIn` bound, times the page.
  budget: { tokensPerRun: 8000 * SUMMARIZE_POSTS_MAX },
  policy: postRead,
  mcp: { expose: true, description: 'Summarise up to twenty posts of the actor’s org at once' },
});
