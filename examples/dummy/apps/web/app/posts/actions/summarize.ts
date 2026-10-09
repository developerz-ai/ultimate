import { postId } from '@postly/domain';
import { t } from '@ultimat3/action';
import { llm } from '@ultimat3/ai';
import { postRead } from '../policy';
import { summarizePrompt } from '../prompts/summarize';

/**
 * The one model call in Postly. There is no `llm` primitive — the framework has eight and a model
 * call is not one of them — so this is an `action` built by a factory, which is what gives it the
 * same policy, the same MCP projection, the same OpenAPI operation and the same contract tests as
 * every other command in this file.
 *
 * `orgId` is in the input for the usual reason: `postRead` decides on it. The named rule matters
 * more here than elsewhere — an inline `can('post:read')` would carry the grant and drop the
 * tenancy predicate, and "summarise any post by id" is exactly the read that must not cross an org.
 */
export const summarize = llm({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.array(t.string) }),
  policy: postRead,
  prompt: summarizePrompt,
  // The one declared place a model call loads data: the input is an id, the prompt needs the row
  // behind it, and a reader can see exactly what was sent.
  vars: async ({ input, ctx }) => {
    const post = await ctx.posts.byId(postId(input.postId));
    return { title: post.title, body: post.body, locale: ctx.locale };
  },
  // No `scope`, and that is now the safe answer: the default partitions on the calling ACTOR.
  // Cosine similarity has no notion of a tenant, so the old `'global'` default answered one org
  // with another's summary — a shared store has to be written down (`scope: () => 'global'`).
  cache: { semantic: { threshold: 0.97, ttl: '7d' } },
  // Refused before a token is spent, never truncated after — a runaway loop costs one refusal
  // instead of a bill.
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  // The answer is two sentences and four tags. Left at the 4,096-token default, the pre-flight
  // estimate — the WHOLE ceiling at the output rate — priced every call at 6 cents against the
  // 5-cent `costPerCall` above, so `summarize` was refused for every post before a token was sent.
  maxTokens: 512,
  mcp: { expose: true, description: 'Summarise a post into two sentences and up to four tags' },
});
