/**
 * Four small holes a review of the unattended-agent work found, each with its failure first.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, UltimateError, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { billedOf } from './billed';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { inProcessTool } from './in-process-tool';
import { llm } from './llm';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { registerModel } from './models';
import { openAiProvider } from './openai-provider';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider } from './provider';
import { anthropicProvider, costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import { ignoredSampling } from './sampling';
import { replaying } from './sse-transcript-fixture';
import { runLlmToolCall } from './tools';

useFixtureModels();
const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ctx = () => ctxOf({ actor: userActor({ id: 'u' }) });
const prompt = (id: string) =>
  definePrompt<{ q: string }>({ id, version: '1.0.0', template: '{{q}}' });
const IO = { input: t.object({ q: t.string }), output: t.object({ a: t.string }) };

beforeEach(() => {
  resetAiRuntime();
});

describe("a tool that itself calls a model: its spend is the run's spend", () => {
  /** The outer agent asks its tool, then answers; the inner llm() answers wrongly twice. */
  function model(innerValid: boolean): void {
    let outer = 0;
    const provider: Provider = {
      name: 'scripted',
      models: [FIXTURE_MODEL],
      generate(request: GenerateRequest) {
        const isOuter = (request.tools ?? []).some((tool) => tool.name === 'judge');
        const call = isOuter
          ? outer++ === 0
            ? { id: 'o1', name: 'judge', input: { q: 'x' } }
            : { id: 'o2', name: 'respond', input: { a: 'done' } }
          : { id: 'i', name: 'respond', input: innerValid ? { a: 'ok' } : { wrong: 1 } };
        const result: GenerateResult = {
          model: FIXTURE_MODEL,
          text: '',
          toolCalls: [call],
          stopReason: 'tool_use',
          stopDetails: undefined,
          usage: USAGE,
          cost: costOf(FIXTURE_MODEL, USAGE),
        };
        return Promise.resolve(result);
      },
      stream: (request) => echoProvider().stream(request),
    };
    configureAi({
      gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }),
    });
  }
  const declare = (name: string) => {
    const inner = llm({
      ...IO,
      prompt: prompt(`${name}-inner`),
      vars: ({ input }) => ({ q: input.q }),
      policy: allow(),
    }).named(`${name}Inner`);
    const judge = inProcessTool({
      name: 'judge',
      description: 'Ask the verifier.',
      input: t.object({ q: t.string }),
      execute: ({ input }) => inner(input, { ctx: ctx() }),
    });
    return agent({
      ...IO,
      prompt: prompt(`${name}-outer`),
      vars: ({ input }) => ({ q: input.q }),
      tools: [judge],
      policy: allow(),
    }).named(`${name}Outer`);
  };

  test('AgentRun.usage counts the nested calls: 2 outer turns + 1 inner call', async () => {
    model(true);
    const run = await declare('nestedOk').run({ q: 'go' }, { ctx: ctx() });
    expect(run.usage.usage.inputTokens).toBe(300);
  });

  test('a nested call that FAILED (and was read by the model as a tool error) is counted too', async () => {
    model(false);
    // The inner llm() fails its schema twice (2 calls); the outer run still answers (2 turns).
    const run = await declare('nestedFailed').run({ q: 'go' }, { ctx: ctx() });
    expect(run.usage.usage.inputTokens).toBe(400);
  });

  test('and meta.billed of a failing outer run includes them', async () => {
    model(false);
    const outer = declare('nestedBilled');
    const strict = agent({
      ...IO,
      prompt: prompt('nested-billed-strict'),
      vars: ({ input }) => ({ q: input.q }),
      tools: [
        inProcessTool({
          name: 'judge',
          description: 'Ask the outer agent, which asks the verifier.',
          input: t.object({ q: t.string }),
          execute: ({ input }) => outer(input, { ctx: ctx() }),
        }),
      ],
      policy: allow(),
      maxTurns: 1,
    }).named('nestedBilledStrict');
    const failed = await strict({ q: 'go' }, { ctx: ctx() }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: 'X_AGENT_MAX_TURNS' });
    // One turn of its own, and the one turn of the agent its tool ran underneath it.
    expect(billedOf(failed)).toMatchObject({ usage: { inputTokens: 200 }, calls: 2 });
  });
});

describe('an in-process refusal is bounded before it is serialised', () => {
  const long = 'row '.repeat(5_000);
  const tool = (extra: object = {}) =>
    inProcessTool({
      name: 'kbRead',
      description: 'Read.',
      input: t.object({}),
      execute: () => {
        throw new UltimateError({ code: 'X_KB_TOO_MUCH', cause: long, fix: long });
      },
      ...extra,
    });

  test('cause and fix are cut to a length that leaves the JSON whole', async () => {
    const result = await runLlmToolCall(
      [tool()],
      { id: 'c', name: 'kbRead', input: {} },
      userActor({ id: 'u' }),
    );
    const parsed = JSON.parse(result.content) as { error: { cause: string; fix: string } };
    expect(parsed.error.cause.length).toBeLessThanOrEqual(1_000);
    expect(parsed.error.fix.length).toBeLessThanOrEqual(500);
    expect(parsed.error.cause.endsWith('…')).toBe(true);
    // Well under the default 4,000-character tool result, so it is never cut mid-string.
    expect(result.content.length).toBeLessThan(2_000);
  });

  test('the agent can withhold every in-process refusal: discloseToolErrors: false', async () => {
    const result = await runLlmToolCall(
      [tool()],
      { id: 'c', name: 'kbRead', input: {} },
      userActor({ id: 'u' }),
      { discloseErrors: false },
    );
    expect(result.content).not.toContain('row row');
    expect(result.content).toContain('X_KB_TOO_MUCH');
  });
});

describe('llm.sampling.ignored names a knob the WIRE has no word for', () => {
  test('seed on a model only an Anthropic-format provider serves', () => {
    registerModel({
      id: 'vendor/anthropic-format',
      contextWindow: 1_000,
      maxOutput: 100,
      inputPerMillion: { minor: 1, currency: 'USD' },
      outputPerMillion: { minor: 1, currency: 'USD' },
      cacheMinimumTokens: 1,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
      sampling: { temperature: true, seed: true },
    });
    const messages = anthropicProvider({ apiKey: 'k', models: ['vendor/anthropic-format'] });
    const chat = openAiProvider({ apiKey: 'k', models: ['vendor/anthropic-format'] });
    const asked = { temperature: 0, seed: 7 };
    const wires = (providers: Provider[]) =>
      providerGateway({ providers }).samplingWires?.('vendor/anthropic-format');
    expect(ignoredSampling('vendor/anthropic-format', asked, wires([messages]))).toEqual(['seed']);
    expect(ignoredSampling('vendor/anthropic-format', asked, wires([chat]))).toEqual([]);
    // Served by both: a provider that can send it exists, so it is not "ignored".
    expect(ignoredSampling('vendor/anthropic-format', asked, wires([messages, chat]))).toEqual([]);
  });
});

describe('two streamed calls with neither an index nor an id', () => {
  test('cannot be told apart, and are refused as unreadable arguments — never run as one call', async () => {
    const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const text =
      frame({
        choices: [
          { delta: { tool_calls: [{ function: { name: 'readDoc', arguments: '{"id":"a"}' } }] } },
        ],
      }) +
      frame({
        choices: [
          { delta: { tool_calls: [{ function: { name: 'readDoc', arguments: '{"id":"b"}' } }] } },
        ],
      }) +
      frame({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }) +
      'data: [DONE]\n\n';
    const provider = openAiProvider({
      apiKey: 'k',
      models: ['gpt-5.6-sol'],
      fetch: replaying(text).fetch,
    });
    const outcome = await provider
      .generate({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 20_000,
      })
      .catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'X_LLM_TOOL_ARGUMENTS_INVALID' });
    expect((outcome as { cause: string }).cause).toContain('no index and no id');
  });
});
