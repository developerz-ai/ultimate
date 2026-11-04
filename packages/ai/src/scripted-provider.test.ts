// `scriptedProvider`: every turn form driven through a real `agent()`, and the one refusal that
// keeps a runaway loop from reading as a pass — more calls than turns is an error, never a repeat.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { registerModel } from './models';
import { definePrompt } from './prompt';
import type { StreamChunk, TokenUsage } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ScriptedProvider } from './scripted-provider';
import { scriptedProvider } from './scripted-provider';
import type { ProjectableAction } from './tools';

useFixtureModels();

const ran: string[] = [];
beforeEach(() => {
  ran.length = 0;
});

const tool = (name: string): ProjectableAction => ({
  name,
  description: `${name} one document`,
  mcp: { expose: true },
  run: () => {
    ran.push(name);
    return Promise.resolve(`${name} ok`);
  },
});

let seq = 0;
function install(provider: ScriptedProvider) {
  resetAiRuntime();
  configureAi({ gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }) });
  seq += 1;
  return agent({
    input: t.object({ topic: t.string }),
    output: t.object({ title: t.string }),
    prompt: definePrompt<{ topic: string }>({
      id: `scripted-${seq}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [tool('readDoc'), tool('publish')],
    policy: allow(),
    maxTurns: 6,
  }).named(`scripted${seq}`);
}

const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });

describe('every turn form, through a real agent()', () => {
  test('text, call, calls and answer each arrive as the turn they script, in order', async () => {
    const provider = scriptedProvider({
      turns: [
        { text: 'not json, so the agent asks for a repair' },
        { call: 'readDoc', input: { id: 'kb-1' } },
        { calls: [{ call: 'readDoc', input: { id: 'kb-2' } }, { call: 'publish' }] },
        { answer: { title: 'Tides' } },
      ],
    });
    const write = install(provider);

    expect(await write({ topic: 'tides' }, { ctx: ctx() })).toEqual({ title: 'Tides' });
    expect(provider.seen).toHaveLength(4);
    expect(ran).toEqual(['readDoc', 'readDoc', 'publish']);
    // Both calls of the `calls` turn were answered, each under its own id, in the next request.
    const last = JSON.stringify(provider.seen[3]?.messages);
    expect(last).toContain('"tool_use_id":"call-3-1"');
    expect(last).toContain('"tool_use_id":"call-3-2"');
    expect(last).toContain('"input":{"id":"kb-2"}');
  });

  test('a text turn that is JSON answers as prose, the JSON-in-text path', async () => {
    const provider = scriptedProvider({ turns: [{ text: '{"title":"Prose"}' }] });
    expect(await install(provider)({ topic: 'tides' }, { ctx: ctx() })).toEqual({
      title: 'Prose',
    });
  });

  test('`usage` is every turn’s usage, and the run sums it', async () => {
    const usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const provider = scriptedProvider({
      turns: [{ call: 'readDoc' }, { answer: { title: 'Tides' } }],
      usage,
    });
    const run = await install(provider).run({ topic: 'tides' }, { ctx: ctx() });
    expect(run.usage.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 400 });
  });
});

describe('running out of turns', () => {
  test('one call more than the script holds raises X_AI_SCRIPT_EXHAUSTED, never the last turn again', async () => {
    const provider = scriptedProvider({ turns: [{ call: 'readDoc', input: { id: 'kb-1' } }] });
    const write = install(provider);
    const error = await write({ topic: 'tides' }, { ctx: ctx() }).then(
      () => expect.unreachable('a loop past its script must not pass'),
      (thrown: unknown) => thrown,
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_AI_SCRIPT_EXHAUSTED');
    expect(isUltimateError(error) ? error.cause : '').toContain('1 turn');
    expect(ran).toEqual(['readDoc']);
    expect(provider.seen).toHaveLength(2);
  });

  test('an empty script refuses the first call', async () => {
    const provider = scriptedProvider({ turns: [] });
    const thrown = await provider
      .generate({ model: FIXTURE_MODEL, messages: [], maxTokens: 64 })
      .then(
        () => expect.unreachable('no turns, no answer'),
        (error: unknown) => error,
      );
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_AI_SCRIPT_EXHAUSTED');
  });
});

describe('the provider shape', () => {
  test('serves a model registered after it was built, through the registry getter', () => {
    const provider = scriptedProvider({ turns: [] });
    expect(provider.models).not.toContain('scripted-late-model');
    registerModel({
      id: 'scripted-late-model',
      contextWindow: 10_000,
      maxOutput: 1_000,
      inputPerMillion: { minor: 100, currency: 'USD' },
      outputPerMillion: { minor: 100, currency: 'USD' },
      cacheMinimumTokens: 1_024,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    expect(provider.models).toContain('scripted-late-model');
  });

  test('a direct call naming no model is refused, as every shipped provider refuses it', async () => {
    const provider = scriptedProvider({ turns: [{ text: 'never read' }] });
    const thrown = await provider.generate({ messages: [], maxTokens: 64 }).then(
      () => expect.unreachable('the double must not choose a model'),
      (error: unknown) => error,
    );
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_AI_MODEL_UNRESOLVED');
    expect(provider.seen).toEqual([]);
  });

  test('`name` is what the gateway reports the call was served by', () => {
    expect(scriptedProvider({ turns: [] }).name).toBe('scripted');
    expect(scriptedProvider({ turns: [], name: 'stub' }).name).toBe('stub');
  });

  test('`stop` overrides the stop reason the turn would otherwise report', async () => {
    const provider = scriptedProvider({
      turns: [{ call: 'readDoc', stop: 'max_tokens' }, { text: 'hi' }],
    });
    const cut = await provider.generate({ model: FIXTURE_MODEL, messages: [], maxTokens: 64 });
    expect(cut.stopReason).toBe('max_tokens');
    const prose = await provider.generate({ model: FIXTURE_MODEL, messages: [], maxTokens: 64 });
    expect(prose.stopReason).toBe('end_turn');
    expect(prose.toolCalls).toEqual([]);
  });

  test('a stream takes its turn when it is called, not when it is first read', async () => {
    const provider = scriptedProvider({ turns: [{ text: 'first' }, { text: 'second' }] });
    const early = provider.stream({ model: FIXTURE_MODEL, messages: [], maxTokens: 64 });
    const later = await provider.generate({ model: FIXTURE_MODEL, messages: [], maxTokens: 64 });
    expect(provider.seen).toHaveLength(2);
    expect(later.text).toBe('second');
    const chunks: StreamChunk[] = [];
    for await (const chunk of early) chunks.push(chunk);
    expect(chunks[0]).toEqual({ type: 'text', text: 'first' });
  });

  test('a stream past the script is refused on its first read', async () => {
    const stream = scriptedProvider({ turns: [] }).stream({
      model: FIXTURE_MODEL,
      messages: [],
      maxTokens: 64,
    });
    const thrown = await (async () => {
      for await (const _chunk of stream) return expect.unreachable('no turn to stream');
    })().then(
      () => expect.unreachable('no turn to stream'),
      (error: unknown) => error,
    );
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_AI_SCRIPT_EXHAUSTED');
  });

  test('a streamed turn yields its text, its tool calls and the result, and is seen once', async () => {
    const provider = scriptedProvider({
      turns: [{ calls: [{ call: 'readDoc', input: { id: 'kb-1' } }, { call: 'publish' }] }],
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.stream({
      model: FIXTURE_MODEL,
      messages: [],
      maxTokens: 64,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(['tool-call', 'tool-call', 'done']);
    expect(provider.seen).toHaveLength(1);
    const done = chunks.at(-1);
    expect(done?.type === 'done' ? done.result.toolCalls.map((c) => c.id) : []).toEqual([
      'call-1-1',
      'call-1-2',
    ]);
  });
});
