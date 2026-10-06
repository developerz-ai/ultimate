// Single responsibility: the gateway's response cache key, and what a cache that fails to WRITE
// costs. The key named tools by name only — every `llm()` tool is `respond` — so an answer shaped
// for an old output schema was served after a schema change; and a throwing `set` after a paid,
// recorded call turned the answer into a failure the caller retried and paid for twice.

import { describe, expect, test } from 'bun:test';
import { MemoryBudgetStore } from './budget';
import { EchoProvider } from './echo-provider';
import { cacheKeyFor, createGateway } from './gateway';
import type { GenerateRequest } from './provider';
import type { LlmTool } from './tools';

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

describe('cacheKeyFor', () => {
  test('two requests differing only in the respond schema do not share a key', () => {
    const before = cacheKeyFor({ ...base, tools: [respond({ summary: { type: 'string' } })] });
    const after = cacheKeyFor({
      ...base,
      tools: [respond({ summary: { type: 'string' }, tags: { type: 'array' } })],
    });
    expect(after).not.toBe(before);
  });

  test('a tool description is part of what the answer is', () => {
    const tool = respond({ summary: { type: 'string' } });
    expect(cacheKeyFor({ ...base, tools: [tool] })).not.toBe(
      cacheKeyFor({ ...base, tools: [{ ...tool, description: 'answer tersely' }] }),
    );
  });

  test('the key is core’s fingerprint: fixed width, and blind to key order', () => {
    const key = cacheKeyFor(base);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    const reordered: GenerateRequest = {
      maxTokens: 64,
      messages: [{ content: 'summarise', role: 'user' }],
      model: 'claude-opus-5',
    };
    expect(cacheKeyFor(reordered)).toBe(key);
  });
});

describe('a cache that cannot write', () => {
  test('the paid answer still reaches the caller, billed once', async () => {
    const store = new MemoryBudgetStore();
    let calls = 0;
    const echo = new EchoProvider();
    const gateway = createGateway({
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
