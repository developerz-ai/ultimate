/**
 * M12 (25.0.0): apps bring their own models and providers. The framework ships no vendor choice —
 * no default model — and no vendor data — no catalogue row — so every id a call can reach is one
 * the app registered, and a call that names none is refused naming the app's three places.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { asyncRefusal, refusal } from './bounds-fixture';
import { echoProvider } from './echo-provider';
import { LlmRefusedError } from './errors';
import type { AiFetch } from './fetch-seam';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { modelForCall, resolveModel } from './model-resolve';
import { moreCapableThan, registerModel } from './models';
import { openAiProvider } from './openai-provider';
import { definePrompt } from './prompt';
import type { Provider } from './provider';
import { anthropicProvider, costOf } from './provider';
import { configureAi } from './runtime';

useFixtureModels();

const Input = t.object({ id: t.string });
const Output = t.object({ answer: t.string });
const ctx = () => ctxOf({});

let seq = 0;
const prompt = (model?: string) => {
  seq += 1;
  return definePrompt<{ id: string }>({
    id: `neutral-${seq}`,
    version: '1',
    template: 'Answer {{id}}.',
    ...(model === undefined ? {} : { model }),
  });
};

/** The three places, as a fix line has to name them for an app to paste one. */
function namesTheThreePlaces(fix: string): void {
  expect(fix).toContain('model: modelId on the llm()/agent() declaration');
  expect(fix).toContain('definePrompt');
  expect(fix).toContain('providerGateway({ …, defaultModel: modelId })');
  // No vendor: the fix is the app's shape, never an id the framework would choose.
  expect(fix).not.toMatch(/claude-|gpt-/);
}

/** A provider that records whether it was ever asked: a refusal must come before it. */
function spy(): { provider: Provider; asked: () => number } {
  let asked = 0;
  const echo = echoProvider();
  return {
    provider: {
      name: 'spy',
      get models() {
        return echo.models;
      },
      generate: (request) => {
        asked += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    },
    asked: () => asked,
  };
}

describe('no vendor id is reachable unless the app registered it', () => {
  // A fresh process, so no suite's registrations can stand in for the package's own state.
  test('importing the package registers no model and exports no vendor list or default', async () => {
    const probe = `
      const ai = await import(${JSON.stringify(Bun.resolveSync('./index.ts', import.meta.dir))});
      const vendorIds = ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5',
        'claude-fable-5-1', 'claude-sonnet-5-5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
      const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const priced = vendorIds.filter((id) => { try { ai.costOf(id, usage); return true; } catch { return false; } });
      const exported = ['DEFAULT_MODEL', 'ANTHROPIC_MODEL_IDS', 'OPENAI_MODEL_IDS', 'registerOpenAiModels']
        .filter((name) => Object.hasOwn(ai, name));
      console.log(JSON.stringify({ ids: ai.modelIds(), priced, exported }));
    `;
    const run = Bun.spawnSync([process.execPath, '--eval', probe], {
      stderr: 'pipe',
      timeout: 20_000,
    });
    expect(run.stderr.toString()).toBe('');
    expect(JSON.parse(run.stdout.toString())).toEqual({ ids: [], priced: [], exported: [] });
  });

  test('costOf an unregistered id is X_AI_MODEL_UNKNOWN, and the fix is registerModel', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const error = refusal(() => costOf('acme-unregistered', usage));
    expect(error.code).toBe('X_AI_MODEL_UNKNOWN');
    expect(error.fix).toContain('registerModel(');
    expect(error.cause).toContain('registers no model of its own');
  });

  test('a gateway call on an unregistered id is refused before the budget or the provider', async () => {
    const { provider, asked } = spy();
    const gateway = providerGateway({ providers: [provider], budget: { request: 1_000_000 } });
    const error = await asyncRefusal(() =>
      gateway.generate({ model: 'acme-unregistered', messages: [], maxTokens: 8 }),
    );
    expect(error.code).toBe('X_AI_MODEL_UNKNOWN');
    expect(error.fix).toContain('registerModel(');
    expect(asked()).toBe(0);
  });
});

describe('a call that names no model is refused, naming the three places', () => {
  test('resolveModel with nothing declared', () => {
    const error = refusal(() => resolveModel('gateway', undefined, undefined));
    expect(error.code).toBe('X_AI_MODEL_UNRESOLVED');
    namesTheThreePlaces(error.fix);
  });

  test('the precedence is declaration, then prompt, then the gateway', () => {
    expect(resolveModel('llm', 'a', 'b', 'c')).toBe('a');
    expect(resolveModel('llm', undefined, 'b', 'c')).toBe('b');
    expect(resolveModel('llm', undefined, undefined, 'c')).toBe('c');
  });

  test('llm() under a gateway with no defaultModel, on a prompt with none', async () => {
    const { provider, asked } = spy();
    configureAi({ gateway: providerGateway({ providers: [provider] }) });
    const unchosen = llm({
      input: Input,
      output: Output,
      prompt: prompt(),
      vars: ({ input }) => ({ id: input.id }),
      policy: allow(),
    }).named('unchosenLlm');
    const error = await asyncRefusal(() => unchosen({ id: '1' }, { ctx: ctx() }));
    expect(error.code).toBe('X_AI_MODEL_UNRESOLVED');
    namesTheThreePlaces(error.fix);
    expect(asked()).toBe(0);
  });

  test('agent() the same way', async () => {
    const { provider, asked } = spy();
    configureAi({ gateway: providerGateway({ providers: [provider] }) });
    const unchosen = agent({
      input: Input,
      output: Output,
      prompt: prompt(),
      vars: ({ input }) => ({ id: input.id }),
      tools: [],
      policy: allow(),
    }).named('unchosenAgent');
    const error = await asyncRefusal(() => unchosen({ id: '1' }, { ctx: ctx() }));
    expect(error.code).toBe('X_AI_MODEL_UNRESOLVED');
    namesTheThreePlaces(error.fix);
    expect(asked()).toBe(0);
  });

  test("a prompt's model needs no gateway default, and the gateway's answers when nothing else does", () => {
    configureAi({ gateway: providerGateway({ providers: [], defaultModel: FIXTURE_MODEL }) });
    expect(modelForCall('llm', 'p@1', undefined, 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(modelForCall('llm', 'p@1', undefined, undefined)).toBe(FIXTURE_MODEL);
  });
});

describe('the providers choose no model either', () => {
  test('EchoProvider has no id of its own: a direct call naming none is refused', async () => {
    const echo = echoProvider();
    const error = await asyncRefusal(() => echo.generate({ messages: [], maxTokens: 8 }));
    expect(error.code).toBe('X_AI_MODEL_UNRESOLVED');
    const answered = await echo.generate({ model: FIXTURE_MODEL, messages: [], maxTokens: 8 });
    expect(answered.model).toBe(FIXTURE_MODEL);
  });

  // One parity case over every shipped provider: a provider's first listed model was a fourth
  // place a model could come from, reachable only by a direct call — the one caller the gateway's
  // resolution never sees. Both transports, and nothing may leave the process before the refusal.
  test('every provider refuses a direct call naming no model, on both transports, before the socket', async () => {
    let sockets = 0;
    const fetch: AiFetch = async () => {
      sockets += 1;
      return new Response('{}', { status: 200 });
    };
    const providers: readonly Provider[] = [
      echoProvider(),
      anthropicProvider({ apiKey: 'k', models: [FIXTURE_MODEL], fetch }),
      openAiProvider({ apiKey: 'k', models: ['gpt-5.6-sol'], fetch }),
    ];
    for (const provider of providers) {
      const request = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 } as const;
      const generated = await asyncRefusal(() => provider.generate(request));
      expect({ provider: provider.name, code: generated.code }).toEqual({
        provider: provider.name,
        code: 'X_AI_MODEL_UNRESOLVED',
      });
      namesTheThreePlaces(generated.fix);
      const streamed = await asyncRefusal(async () => {
        for await (const _ of provider.stream(request)) break;
      });
      expect({ provider: provider.name, code: streamed.code }).toEqual({
        provider: provider.name,
        code: 'X_AI_MODEL_UNRESOLVED',
      });
    }
    expect(sockets).toBe(0);
  });

  test("AnthropicProvider serves the app's list, and an empty one is refused at construction", () => {
    expect(anthropicProvider({ models: ['acme-claude'] }).models).toEqual(['acme-claude']);
    const error = refusal(() => anthropicProvider({ models: [] }));
    expect(error.code).toBe('X_AI_REQUEST_INVALID');
    expect(error.fix).toContain('anthropicProvider({ models:');
  });

  // Plain JS, or a cast, reaches the constructor with no argument at all: that is the same boot
  // mistake as an empty list and must get the same coded refusal, never a TypeError on `.models`.
  test('a provider built with no config at all gets the coded empty-list refusal', () => {
    const build = anthropicProvider as unknown as () => Provider;
    const anthropic = refusal(() => build());
    expect(anthropic.code).toBe('X_AI_REQUEST_INVALID');
    expect(anthropic.fix).toContain('anthropicProvider({ models:');
    const openAi = refusal(() => (openAiProvider as unknown as () => Provider)());
    expect(openAi.code).toBe('X_AI_REQUEST_INVALID');
    expect(openAi.fix).toContain('openAiProvider({ …, models:');
  });
});

describe("the refusal ladder is the app's rows only", () => {
  test('a model alone in its family has no rung above it, and the fix suggests none', () => {
    registerModel({
      id: 'acme-solo',
      family: 'acme-solo',
      contextWindow: 1_000,
      maxOutput: 100,
      inputPerMillion: { minor: 1, currency: 'USD' },
      outputPerMillion: { minor: 1, currency: 'USD' },
      cacheMinimumTokens: 0,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    expect(moreCapableThan('acme-solo')).toBeUndefined();
    const refused = new LlmRefusedError({
      prompt: 'p@1',
      model: 'acme-solo',
      alternative: moreCapableThan('acme-solo'),
      category: undefined,
      explanation: undefined,
    });
    expect(refused.fix).not.toContain('set model:');
    expect(refused.fix).toContain('no model your app registered');
  });
});
