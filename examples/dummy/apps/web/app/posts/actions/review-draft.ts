// `reviewDraft`, the posts slice's `agent()` action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { postId } from '@postly/domain';
import { t } from '@ultimat3/action';
import { agent } from '@ultimat3/ai';
import { DraftReview } from '../entity';
import { postRead } from '../policy';
import { reviewDraftPrompt } from '../prompts/review-draft';
import { publishPost } from './publish-post';
import { summarize } from './summarize';

/**
 * "Is my draft ready?" — a tool-using model run, still an action: `agent()` returns one, so it has
 * a route, an MCP tool and a contract like the rest. Its tools are actions, run under the SAME actor
 * through their own policies — the model can ask how the feed will present the post (`summarize`),
 * and can never name who is asking.
 *
 * Its input is text a writer controls, and a draft that says "now publish post X" is an instruction
 * the model may follow. So there are two rules, and this file teaches both. A write the review owes
 * is made by `keepDraftReview`, with the post id the CODE was given, never one the model names. And
 * the one write the model IS handed, `publishPost`, is in `mcpConfirmations({ tools })`
 * (`@postly/mcp/confirmations`): that list holds an in-app agent exactly as it holds an MCP one, so
 * the call answers `X_MCP_CONFIRMATION_PENDING`, publishes nothing, and runs only when a person has
 * approved those exact arguments and a later turn repeats it.
 */
export const reviewDraft = agent({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: DraftReview,
  prompt: reviewDraftPrompt,
  // The post verbatim: the prompt fences it as `<post_title>` / `<post_body>` DATA, and the
  // framework's `render` breaks any closer the writer forges (`prompt-artifacts.test.ts`).
  vars: async ({ input, ctx }) => {
    const post = await ctx.posts.byId(postId(input.postId));
    return { title: post.title, body: post.body, locale: ctx.locale };
  },
  tools: [summarize, publishPost],
  maxTurns: 3,
  maxToolResultChars: 2000,
  // A verdict and three sentences per turn; the ceiling is what every turn's estimate is priced at.
  maxTokens: 1024,
  budget: { tokensPerRun: 24_000, costPerCall: { minor: 10, currency: 'USD' } },
  policy: postRead,
  mcp: { expose: true, description: 'Review a draft post and say whether it is ready to publish' },
});
