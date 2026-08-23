// May a client run this model call again? The classification every ai code carries into `--json`,
// asserted on the RENDERED document — and the one code that is BOTH, decided at its throw site.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorRetry } from '@ultimat3/core';
import { declaredErrorRetry, registerErrorRetry } from '@ultimat3/core';
import {
  AI_ERROR_CODES,
  AiBudgetExceededError,
  AiKeyMissingError,
  AiProviderUnavailableError,
  AiTransportError,
  LlmTruncatedError,
} from './errors';
import { AI_ERROR_RETRY } from './errors-retry';
import { createGateway } from './gateway';
import { ANTHROPIC_MODEL_IDS, DEFAULT_MODEL } from './models';
import type { GenerateResult, Provider, StreamChunk } from './provider';

/**
 * Sampled at MODULE SCOPE, before any hook: "does importing this package classify its codes" is a
 * question a `beforeEach` that re-registers would answer for a module that registers nothing.
 */
const atImport = new Map<string, ErrorRetry | undefined>(
  AI_ERROR_CODES.map((code) => [code, declaredErrorRetry(code)]),
);

beforeEach(() => {
  // Another file's `resetErrorRetry` cannot leave this suite reading an empty registry.
  registerErrorRetry(AI_ERROR_RETRY);
});

const rendered = (error: unknown): unknown =>
  (JSON.parse(JSON.stringify(error)) as { retry?: unknown }).retry;

describe('a provider that could not answer is retryable', () => {
  test('a 503 from the provider renders retryable, where it rendered terminal', () => {
    expect(rendered(new AiTransportError({ provider: 'down', status: 503, detail: 'oh' }))).toBe(
      'retryable',
    );
  });

  test('retryable, not retry-after: nothing in this package carries a stated delay', () => {
    // `statedDelayMs` and `@ultimat3/http`'s `retryAfterOf` read ONE spelling —
    // `meta.retryAfterSeconds` — and neither provider parses the `Retry-After` header off a 429, so
    // no ai error has ever carried it. `retry-after` would name a time nobody supplied.
    const rateLimited = new AiTransportError({ provider: 'p', status: 429, detail: 'slow down' });
    expect(rendered(rateLimited)).toBe('retryable');
    expect(rateLimited.meta?.['retryAfterSeconds']).toBeUndefined();
  });

  test('every candidate failing collects into one retryable refusal', () => {
    expect(
      rendered(new AiProviderUnavailableError({ model: 'm', attempts: ['down#1: 503'] })),
    ).toBe('retryable');
  });
});

// The same code is raised for "every provider I tried was down" and for "nothing I am configured
// with serves this model". The first is a moment, the second is an edit to app.config.ts, and a
// worker that retries the second burns its whole policy proving the config is still wrong.
describe('the same code is terminal where the throw site knows better', () => {
  test('no configured provider serves the model is terminal, per instance', () => {
    const unserved = new AiProviderUnavailableError({
      model: 'm',
      attempts: ['anthropic: does not serve m'],
      unserved: true,
    });
    expect(rendered(unserved)).toBe('terminal');
  });

  test('the gateway raises the terminal one when no provider serves the model', async () => {
    const gateway = createGateway({ providers: [] });
    let thrown: unknown;
    try {
      await gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    } catch (error) {
      thrown = error;
    }
    expect(rendered(thrown)).toBe('terminal');
  });

  test('the gateway raises the retryable one when a provider served it and failed', async () => {
    const down: Provider = {
      name: 'down',
      models: ANTHROPIC_MODEL_IDS,
      generate: (): Promise<GenerateResult> =>
        Promise.reject(new AiTransportError({ provider: 'down', status: 503, detail: 'oh' })),
      // biome-ignore lint/correctness/useYield: unused by this test
      async *stream(): AsyncIterable<StreamChunk> {
        throw new AiTransportError({ provider: 'down', status: 503, detail: 'oh' });
      },
    };
    const gateway = createGateway({
      providers: [down],
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });
    let thrown: unknown;
    try {
      await gateway.generate({ model: DEFAULT_MODEL, messages: [], maxTokens: 8 });
    } catch (error) {
      thrown = error;
    }
    expect(rendered(thrown)).toBe('retryable');
  });
});

describe('the permanent codes stay terminal', () => {
  test('a missing key, an exceeded budget and a truncated answer all fail the same way twice', () => {
    expect(rendered(new AiKeyMissingError({ provider: 'a', envVar: 'A_KEY' }))).toBe('terminal');
    expect(
      rendered(new AiBudgetExceededError({ scope: 'org', requested: 10, remaining: 1, limit: 10 })),
    ).toBe('terminal');
    expect(rendered(new LlmTruncatedError({ prompt: 'p', maxTokens: 100 }))).toBe('terminal');
  });
});

describe('the table', () => {
  test('one exception, and it is the transport code', () => {
    expect(Object.keys(AI_ERROR_RETRY)).toEqual(['X_AI_PROVIDER_UNAVAILABLE']);
    expect(AI_ERROR_RETRY.X_AI_PROVIDER_UNAVAILABLE).toBe('retryable');
  });

  test('nothing is registered AS terminal, and that is the decision, not an oversight', () => {
    // `@ultimat3/jobs` dead-letters a REGISTERED `terminal` on attempt 1, where an unclassified
    // code keeps the job's own attempt count. That is probably right for `X_LLM_REFUSED` and
    // `X_AI_BUDGET_EXCEEDED` and it is a change to how every app's jobs fail, so it is somebody's
    // deliberate decision — and this test is what makes adding one a decision.
    for (const code of AI_ERROR_CODES) {
      if (code === 'X_AI_PROVIDER_UNAVAILABLE') continue;
      expect(atImport.get(code), code).toBeUndefined();
    }
  });

  test('IMPORTING the package registers every entry — a table nobody registers classifies nothing', () => {
    for (const [code, retry] of Object.entries(AI_ERROR_RETRY)) {
      expect(atImport.get(code), code).toBe(retry);
    }
  });
});
