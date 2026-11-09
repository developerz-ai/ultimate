// `meteredRun`: one total across every `llm()` and `agent()` call a piece of work makes — summed
// once however deep the calls nest, still readable from the error when the work fails.

import { describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { billedOf } from './billed';
import { exactCostOf } from './cost';
import { providerGateway } from './gateway';
import { declare, POST_ID, promptFor } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { TokenUsage } from './provider';
import { meteredRun } from './run-meter';
import { installAiGateway, resetAiRuntime } from './runtime';
import type { ScriptedTurn } from './scripted-provider';
import { scriptedProvider } from './scripted-provider';

useFixtureModels();

const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const ANSWER = { summary: 'a post about caching', tags: ['cache'] };

function install(...turns: readonly ScriptedTurn[]) {
  resetAiRuntime();
  const provider = scriptedProvider({ turns, usage: USAGE });
  installAiGateway(providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }));
  return provider;
}

const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });

const writer = (summarize: ReturnType<typeof declare>) =>
  agent({
    input: t.object({ topic: t.string }),
    output: t.object({ title: t.string }),
    prompt: definePrompt<{ topic: string }>({
      id: `metered-agent-${crypto.randomUUID()}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    // The agent's tool is itself an `llm()`: a call two levels below the metered run.
    tools: [
      {
        name: 'summarize',
        description: 'Summarise the post',
        mcp: { expose: true },
        run: ({ actor }) => summarize({ postId: POST_ID }, { ctx: ctxOf({ actor }) }),
      },
    ],
    policy: allow(),
  }).named(`meteredWriter${crypto.randomUUID().slice(0, 8)}`);

describe('meteredRun', () => {
  test('two llm() calls and an agent() whose tool calls a third sum once', async () => {
    install(
      { answer: ANSWER },
      { answer: ANSWER },
      { call: 'summarize' },
      { answer: ANSWER },
      { answer: { title: 'Tides' } },
    );
    const summarize = declare(promptFor());
    const write = writer(summarize);

    const { value, billed } = await meteredRun(async () => {
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      return write({ topic: 'tides' }, { ctx: ctx() });
    });

    expect(value).toEqual({ title: 'Tides' });
    // Five provider calls, each counted exactly once: two direct, two agent turns, one in its tool.
    expect(billed?.calls).toBe(5);
    expect(billed?.unsettled).toBe(0);
    expect(billed?.usage).toEqual({
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // Summed exact, never five round-ups: the price of the summed usage.
    expect(billed?.cost).toEqual(
      exactCostOf(FIXTURE_MODEL, { ...USAGE, inputTokens: 5_000, outputTokens: 1_000 }),
    );
  });

  test('a failing call still carries the whole total on the error it throws', async () => {
    // One good answer, then an answer that fails its schema twice: X_LLM_OUTPUT_INVALID.
    install({ answer: ANSWER }, { answer: { wrong: 1 } }, { answer: { wrong: 2 } });
    const summarize = declare(promptFor());

    const error = await meteredRun(async () => {
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      return summarize({ postId: POST_ID }, { ctx: ctx() });
    }).then(
      () => expect.unreachable('the second call fails its schema twice'),
      (thrown: unknown) => thrown,
    );

    expect(isUltimateError(error) ? error.code : error).toBe('X_LLM_OUTPUT_INVALID');
    expect(billedOf(error)?.calls).toBe(3);
    expect(billedOf(error)?.usage.inputTokens).toBe(3_000);
  });

  // A call that never reported usage (transport failure, abort, deadline) is UNSETTLED: counted,
  // never priced. The script running out is one such failure: no answer, no usage.
  test('an unsettled call caught inside the work still reaches the total', async () => {
    install({ answer: ANSWER });
    const summarize = declare(promptFor());

    const { billed } = await meteredRun(async () => {
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      await summarize({ postId: POST_ID }, { ctx: ctx() }).catch(() => undefined);
    });

    expect({ calls: billed?.calls, unsettled: billed?.unsettled }).toEqual({
      calls: 1,
      unsettled: 1,
    });
  });

  test('an unsettled failure beside settled siblings is on the error the work throws', async () => {
    install({ answer: ANSWER }, { answer: ANSWER });
    const summarize = declare(promptFor());

    const error = await meteredRun(async () => {
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      await summarize({ postId: POST_ID }, { ctx: ctx() });
      return summarize({ postId: POST_ID }, { ctx: ctx() });
    }).then(
      () => expect.unreachable('the third call has no turn left'),
      (thrown: unknown) => thrown,
    );

    expect(isUltimateError(error) ? error.code : error).toBe('X_AI_SCRIPT_EXHAUSTED');
    expect({ calls: billedOf(error)?.calls, unsettled: billedOf(error)?.unsettled }).toEqual({
      calls: 2,
      unsettled: 1,
    });
  });

  test('work that starts no model call is billed nothing, not zero', async () => {
    const { value, billed } = await meteredRun(() => 42);
    expect(value).toBe(42);
    expect(billed).toBeUndefined();
  });
});
