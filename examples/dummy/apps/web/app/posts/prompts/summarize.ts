/**
 * The one model call in Postly. Declared like every other primitive: typed input and output,
 * a policy, a budget, and a versioned prompt artifact — so a trace can say which prompt produced
 * which summary, and the semantic cache can be invalidated by bumping the version.
 */

import { tag } from '@postly/db';
import { llm, prompt } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

/** Editing the markdown requires bumping this version: it keys the semantic cache and the traces. */
export const summarizePrompt = prompt('./summarize.v3.md', {
  version: 3,
  slots: t.object({ title: t.string, body: t.string, locale: t.enumerated('en', 'es') }),
});

export const summarize = llm({
  model: 'claude-sonnet-4-5',
  input: t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.string.array() }),
  prompt: summarizePrompt,
  policy: can('feed:read'),
  cache: {
    semantic: { threshold: 0.97, ttl: '7d', scope: ({ orgId }) => orgId },
    invalidates: [tag.post],
  },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  mcp: { expose: true, description: 'Summarise a post into two sentences and up to four tags' },
  async slots({ input, ctx }) {
    const post = await ctx.posts.byId(input.postId);
    return { title: post.title, body: post.body, locale: ctx.actor.locale };
  },
});
