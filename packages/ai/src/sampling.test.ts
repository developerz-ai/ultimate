/**
 * `temperature` and `seed`. The failure first: neither could be SAID — no request field, no
 * declaration key — so a verifier that must answer the same way twice had no way to ask for it.
 * And the constraint that shaped the answer: a reasoning model rejects a sampling parameter with
 * a 400, so a knob is sent only to a model whose row says it takes it.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { promptCacheKey } from './gateway';
import { ANSWER, declare, install, POST_ID, promptFor, stub } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { registerModel } from './models';
import { chatCompletionBody } from './openai-body';
import type { GenerateRequest } from './provider';
import { anthropicProvider } from './provider';
import { resetAiRuntime } from './runtime';
import { ignoredSampling } from './sampling';

useFixtureModels();

const usd = (minor: number) => ({ minor, currency: 'USD' });
const ROW = {
  contextWindow: 200_000,
  maxOutput: 8_000,
  inputPerMillion: usd(100),
  outputPerMillion: usd(400),
  cacheMinimumTokens: 1_024,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
} as const;
const TAKES = 'vendor/takes-sampling';
const REASONS = 'vendor/reasoning-only';
const request = (model: string, extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model,
  messages: [{ role: 'user', content: 'verify' }],
  maxTokens: 100,
  ...extra,
});
const openai = (r: GenerateRequest) =>
  chatCompletionBody({ request: r, model: r.model ?? TAKES, provider: 'openai', stream: false });

beforeEach(() => {
  resetAiRuntime();
  registerModel({ id: TAKES, ...ROW, sampling: { temperature: true, seed: true } });
  // No `sampling`: the shape of every row that predates the field.
  registerModel({ id: REASONS, ...ROW });
});

describe('the chat-completions wire', () => {
  test('sends both knobs to a model whose row takes them', () => {
    const body = openai(request(TAKES, { temperature: 0, seed: 7 }));
    expect(body['temperature']).toBe(0);
    expect(body['seed']).toBe(7);
  });

  test('sends neither to a model whose row does not say so — and says which were left out', () => {
    const asked = request(REASONS, { temperature: 0, seed: 7 });
    const body = openai(asked);
    expect('temperature' in body).toBe(false);
    expect('seed' in body).toBe(false);
    expect(ignoredSampling(REASONS, asked)).toEqual(['temperature', 'seed']);
    expect(ignoredSampling(TAKES, asked)).toEqual([]);
  });

  test('a request that asks for nothing sends nothing', () => {
    const body = openai(request(TAKES));
    expect('temperature' in body).toBe(false);
    expect('seed' in body).toBe(false);
  });
});

describe('the Anthropic wire', () => {
  const wire = anthropicProvider({ apiKey: 'k', models: [TAKES, REASONS] });

  test('sends temperature to a row that takes it, and never a seed — the API has none', () => {
    const body = wire.body(request(TAKES, { temperature: 0.2, seed: 7 }));
    expect(body['temperature']).toBe(0.2);
    expect('seed' in body).toBe(false);
  });

  test('sends nothing to a row that does not take it', () => {
    expect('temperature' in wire.body(request(REASONS, { temperature: 0 }))).toBe(false);
  });
});

describe('llm() and agent() carry them from the declaration', () => {
  test('llm({ temperature, seed }) reaches the request', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    await declare(promptFor(), { temperature: 0, seed: 11 })(
      { postId: POST_ID },
      { ctx: anonymousCtx() },
    );
    expect(seen[0]).toMatchObject({ temperature: 0, seed: 11 });
  });

  test('agent({ temperature, seed }) reaches every turn', async () => {
    const { provider, seen } = stub({ answer: 'done' });
    install(provider);
    const run = agent({
      input: t.object({ postId: t.uuid }),
      output: t.object({ answer: t.string }),
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      tools: [],
      policy: allow(),
      temperature: 0.5,
      seed: 3,
    }).named('sampledAgent');
    await run({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen[0]).toMatchObject({ temperature: 0.5, seed: 3 });
  });

  test.each([
    ['temperature', Number.NaN],
    ['temperature', 2.5],
    ['temperature', -1],
    ['seed', 1.5],
  ])('%s: %p is refused at declaration', (key, value) => {
    expect(() => declare(promptFor(), { [key]: value })).toThrow(key);
  });
});

describe('the response cache', () => {
  test('two requests that differ only in temperature or seed are different entries', () => {
    const base = request(FIXTURE_MODEL);
    expect(promptCacheKey({ ...base, temperature: 0 })).not.toBe(promptCacheKey(base));
    expect(promptCacheKey({ ...base, seed: 1 })).not.toBe(promptCacheKey({ ...base, seed: 2 }));
  });
});

describe('a forced tool choice', () => {
  const one = {
    tools: [{ name: 'respond', description: 'd', input_schema: { type: 'object' as const } }],
  };

  test('names the only tool by default — the shape llm() builds', () => {
    expect(openai(request(TAKES, one))['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'respond' },
    });
  });

  // Measured 2026-10-11 through OpenRouter: `anthropic/claude-sonnet-5.5` answers a named tool
  // with 400 `tool_choice: type "tool" and "any" are not supported for this model` — so every
  // `llm()` call on it failed before a token was generated. The row says so; the tool is then
  // offered under the endpoint's default (`auto`), and a prose answer takes the repair turn.
  test('is left out for a model whose row says it rejects one', () => {
    registerModel({ id: 'vendor/thinks-always', ...ROW, forcedToolChoice: false });
    const body = openai(request('vendor/thinks-always', one));
    expect('tool_choice' in body).toBe(false);
    expect(body['tools']).toHaveLength(1);
  });
});
