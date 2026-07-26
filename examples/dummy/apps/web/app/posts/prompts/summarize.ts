/**
 * The one model call in Postly.
 *
 * There is no `llm` primitive: the framework has eight, and a model call is not one of them.
 * It is an `action` whose handler happens to call the gateway — so it gets the same policy,
 * the same cache invalidation, the same MCP projection and the same tracing as every other
 * mutation, instead of a parallel set of rules that only apply to AI.
 *
 * The prompt itself is a versioned artifact. Bumping `version` changes its content hash, which
 * keys the semantic cache and appears in traces, so a summary can always be attributed to the
 * exact text that produced it.
 */

import { tag } from '@postly/db';
import { action } from '@ultimat3/action';
import { definePrompt } from '@ultimat3/ai';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { summarizeTemplate } from './summarize-template';

/** Editing the markdown requires bumping this version — it keys the cache and the traces. */
export const summarizePrompt = definePrompt({
  id: 'posts.summarize',
  version: '3',
  template: summarizeTemplate,
  model: 'claude-sonnet-5',
  input: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' }, locale: { type: 'string' } },
    required: ['title', 'body', 'locale'],
  },
  output: {
    type: 'object',
    properties: { summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['summary', 'tags'],
  },
});

export const summarize = action({
  input: t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.array(t.string) }),
  policy: can('feed:read'),
  cache: { invalidates: [tag.post] },
  mcp: { expose: true, description: 'Summarise a post into two sentences and up to four tags' },

  async handle({ input, ctx }) {
    const post = await ctx.posts.byId(input.postId);
    // The gateway carries the budget: it refuses before the call rather than truncating after,
    // so a runaway loop costs one refusal instead of a bill.
    const result = await ctx.ai.generate({
      prompt: summarizePrompt,
      vars: { title: post.title, body: post.body, locale: ctx.actor.locale },
    });
    return result.output;
  },
});
