// Single responsibility: the gateway's response cache key, and what a cache that fails to WRITE
// costs. The key named tools by name only — every `llm()` tool is `respond` — so an answer shaped
// for an old output schema was served after a schema change; and a throwing `set` after a paid,
// recorded call turned the answer into a failure the caller retried and paid for twice.

import { describe, expect, test } from 'bun:test';
import { memoryBudgetStore } from './budget';
import { echoProvider } from './echo-provider';
import { promptCacheKey, providerGateway } from './gateway';
import { useFixtureModels } from './model-fixture';
import type { GenerateRequest } from './provider';
import { runMeter } from './run-meter';
import type { LlmTool } from './tools';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

const respond = (properties: NonNullable<LlmTool['input_schema']['properties']>): LlmTool => ({
  name: 'respond',
  description: 'answer',
  input_schema: { type: 'object', properties, required: Object.keys(properties) },
  strict: true,
});

const base: GenerateRequest = {
  model: 'claude-opus-5',
  messages: [{ role: 'user', content: 'summarise' }],
  maxTokens: 64,
};

describe('promptCacheKey', () => {
  test('two requests differing only in the respond schema do not share a key', () => {
    const before = promptCacheKey({ ...base, tools: [respond({ summary: { type: 'string' } })] });
    const after = promptCacheKey({
      ...base,
      tools: [respond({ summary: { type: 'string' }, tags: { type: 'array' } })],
    });
    expect(after).not.toBe(before);
  });

  test('a tool description is part of what the answer is', () => {
    const tool = respond({ summary: { type: 'string' } });
    expect(promptCacheKey({ ...base, tools: [tool] })).not.toBe(
      promptCacheKey({ ...base, tools: [{ ...tool, description: 'answer tersely' }] }),
    );
  });

  test('the key is core’s fingerprint: fixed width, and blind to key order', () => {
    const key = promptCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    const reordered: GenerateRequest = {
      maxTokens: 64,
      messages: [{ content: 'summarise', role: 'user' }],
      model: 'claude-opus-5',
    };
    expect(promptCacheKey(reordered)).toBe(key);
  });
});

describe('a cache that cannot write', () => {
  test('the paid answer still reaches the caller, billed once', async () => {
    const store = memoryBudgetStore();
    let calls = 0;
    const echo = echoProvider();
    const gateway = providerGateway({
      providers: [
        {
          name: 'counting',
          models: echo.models,
          generate(request) {
            calls += 1;
            return echo.generate(request);
          },
          stream: (request) => echo.stream(request),
        },
      ],
      budget: { org: 1_000_000 },
      budgetStore: store,
      cache: {
        get: () => undefined,
        // Handed TO the subject, never this test's verdict.
        set: () => Promise.reject(new Error('cache down')),
      },
    });
    const result = await gateway.scope({ orgKey: 'org:acme' }, () => gateway.generate(base));
    expect(result.text.length).toBeGreaterThanOrEqual(0);
    expect(calls).toBe(1);
    expect(store.spent('org:acme')).toBe(
      result.usage.inputTokens +
        result.usage.outputTokens +
        result.usage.cacheReadTokens +
        result.usage.cacheWriteTokens,
    );
  });
});

/**
 * A prompt-cache hit is not debited, and the gateway's own comment says it costs nothing. It came
 * back carrying the original usage and cost, so a meter summing the run counted it again and read
 * twice what the budget beside it read.
 */
describe('a cache hit', () => {
  const cachedGateway = () => {
    const store = memoryBudgetStore();
    const entries = new Map<string, string>();
    let calls = 0;
    const echo = echoProvider();
    const gateway = providerGateway({
      providers: [
        {
          name: 'counting',
          models: echo.models,
          generate(request) {
            calls += 1;
            return echo.generate(request);
          },
          stream: (request) => echo.stream(request),
        },
      ],
      budget: { org: 1_000_000 },
      budgetStore: store,
      cache: {
        get: (key) => entries.get(key),
        set: (key, value) => {
          entries.set(key, value);
        },
      },
    });
    return { gateway, store, calls: () => calls };
  };

  test('reads zero usage and zero cost, in the same currency', async () => {
    const { gateway } = cachedGateway();
    const scoped = () => gateway.scope({ orgKey: 'org:acme' }, () => gateway.generate(base));
    const miss = await scoped();
    const hit = await scoped();

    expect(hit.text).toBe(miss.text);
    expect(hit.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(hit.cost).toEqual({ minor: 0, currency: miss.cost.currency });
    expect(hit.costExact?.minor).toBe(0);
    expect(hit.costExact?.currency).toBe(miss.costExact?.currency ?? 'absent');
    expect(miss.usage.inputTokens).toBeGreaterThan(0);
  });

  test('miss then hit through one meter totals one call, and the budget moved once', async () => {
    const { gateway, store, calls } = cachedGateway();
    const meter = runMeter();
    const scoped = () => gateway.scope({ orgKey: 'org:acme' }, () => gateway.generate(base));

    const miss = await meter.call(scoped());
    const once = meter.total();
    const spent = store.spent('org:acme');

    await meter.call(scoped());
    expect(calls()).toBe(1);
    expect(store.spent('org:acme')).toBe(spent);
    expect(meter.total()?.usage).toEqual(once?.usage ?? miss.usage);
    expect(meter.total()?.cost).toEqual(once?.cost ?? miss.cost);
  });
});
