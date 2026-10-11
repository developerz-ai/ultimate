/**
 * `llm()` and provider prompt caching: OFF unless the declaration asks. A one-shot call that marks
 * its prefix pays the write premium for a cache nothing may read.
 */

import { describe, expect, test } from 'bun:test';
import { ANSWER, ctxFor, declare, install, POST_ID, promptFor, stub } from './llm-fixture';
import { useFixtureModels } from './model-fixture';
import { registerModel } from './models';
import { chatCompletionBody } from './openai-body';
import { resetAiRuntime } from './runtime';

useFixtureModels();

const run = async (extra: Parameters<typeof declare>[1]) => {
  resetAiRuntime();
  const { provider, seen } = stub(ANSWER);
  install(provider);
  await declare(promptFor(), extra)({ postId: POST_ID }, { ctx: ctxFor('u-1', 'org-1') });
  return seen[0] ?? expect.unreachable('the model was not called');
};

describe('llm() sends no cache mark by default', () => {
  test('no option: no hint on the request, and no mark on an Anthropic-on-OpenRouter body', async () => {
    const request = await run({});
    expect(request.promptCache).toBeUndefined();
    const model = 'anthropic/claude-sonnet-5.5';
    registerModel({
      id: model,
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      inputPerMillion: { minor: 200, currency: 'USD' },
      outputPerMillion: { minor: 1_000, currency: 'USD' },
      cacheMinimumTokens: 512,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    const body = chatCompletionBody({
      request: { ...request, model, system: 'a long stable system prompt' },
      model,
      provider: 'openrouter',
      stream: false,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body['prompt_cache_key']).toBeUndefined();
  });

  test("'auto' and a session key are the declaration's to ask for", async () => {
    expect((await run({ promptCache: 'auto' })).promptCache).toEqual({});
    expect((await run({ promptCache: 'off' })).promptCache).toBeUndefined();
    const keyed = await run({ promptCache: { session: ({ ctx }) => `sum:${ctx.locale}` } });
    expect(keyed.promptCache?.session).toStartWith('sum:');
    expect((await run({ promptCache: { session: 'summaries' } })).promptCache).toEqual({
      session: 'summaries',
    });
  });
});
