// A prompt over the model's window is `X_AI_CONTEXT_OVERFLOW` on both wire formats and both
// transports, never the retryable transport code — and a 400 about anything else stays what it was.
// Apart from `provider-parity.test.ts` because that suite is at its line ceiling.

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { declaredErrorRetry, registerErrorRetry, secret, stringField } from '@ultimat3/core';
import { billedOf } from './billed';
import { AiContextOverflowError, CONTEXT_OVERFLOW_PHRASES } from './context-overflow';
import { AiTransportError } from './errors';
import { AI_ERROR_RETRY } from './errors-retry';
import type { AiFetch } from './fetch-seam';
import { providerGateway } from './gateway';
import { declare, POST_ID, promptFor } from './llm-fixture';
import {
  FIXTURE_ANTHROPIC_IDS,
  FIXTURE_MODEL,
  FIXTURE_OPENAI_IDS,
  registerFixtureModels,
  useFixtureModels,
} from './model-fixture';
import { openAiProvider } from './openai-provider';
import type { GenerateRequest, Provider } from './provider';
import { anthropicProvider } from './provider';
import { configureAi } from './runtime';

useFixtureModels();

const KEY = 'sk-live-overflow';
const ANTHROPIC = 'prompt is too long: 210000 tokens > 200000 maximum';
const OPENAI =
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens.";

beforeEach(() => {
  registerFixtureModels();
  registerErrorRetry(AI_ERROR_RETRY);
});

const answering = (status: number, message: string): AiFetch & { calls: number } => {
  const fetcher = async (): Promise<Response> => {
    fetcher.calls += 1;
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetcher.calls = 0;
  return fetcher;
};

/** Every wire and transport, each answering `status` with `message`. */
function everyPath(status: number, message: string): (() => Promise<unknown>)[] {
  const anthropic = anthropicProvider({
    models: FIXTURE_ANTHROPIC_IDS,
    apiKey: KEY,
    fetch: answering(status, message),
  });
  const openai = openAiProvider({
    apiKey: secret(KEY, 'OPENAI_API_KEY'),
    models: [...FIXTURE_OPENAI_IDS],
    fetch: answering(status, message),
  });
  const ask = (model: string): GenerateRequest => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 16,
  });
  const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
    for await (const _ of stream) {
      // Drained for the throw.
    }
  };
  return [
    () => anthropic.generate(ask(FIXTURE_MODEL)),
    () => drain(anthropic.stream(ask(FIXTURE_MODEL))),
    () => openai.generate(ask('gpt-5.6-sol')),
    () => drain(openai.stream(ask('gpt-5.6-sol'))),
  ];
}

const failureOf = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => expect.unreachable('the call answered'),
    (error: unknown) => error,
  );

const retryOf = (error: unknown): unknown =>
  (JSON.parse(JSON.stringify(error)) as { retry?: unknown }).retry;

describe('a request over the window is its own code on every wire', () => {
  test("each provider's wording is X_AI_CONTEXT_OVERFLOW, terminal, billed nothing", async () => {
    for (const message of [ANTHROPIC, OPENAI]) {
      for (const status of [400, 413]) {
        for (const run of everyPath(status, message)) {
          const error = await failureOf(run);
          expect(error).toBeInstanceOf(AiContextOverflowError);
          expect(stringField(error, 'code')).toBe('X_AI_CONTEXT_OVERFLOW');
          expect(retryOf(error)).toBe('terminal');
          // REGISTERED terminal, not unclassified: a job dead-letters it on attempt 1.
          expect(declaredErrorRetry('X_AI_CONTEXT_OVERFLOW')).toBe('terminal');
          // Settled at zero, never counted unsettled: the refusal reported its own bill.
          expect(billedOf(error)).toMatchObject({ calls: 1, unsettled: 0, cost: { minor: 0 } });
        }
      }
    }
  });

  test('every phrase in the table is recognised, case aside', async () => {
    for (const phrase of CONTEXT_OVERFLOW_PHRASES) {
      for (const run of everyPath(400, `Upstream: ${phrase.toUpperCase()} (sent 9000)`)) {
        expect(stringField(await failureOf(run), 'code')).toBe('X_AI_CONTEXT_OVERFLOW');
      }
    }
  });

  test('a 400 about something else stays the transport code', async () => {
    for (const run of everyPath(400, 'tools.0.input_schema: type must be object')) {
      const error = await failureOf(run);
      expect(error).toBeInstanceOf(AiTransportError);
      expect(stringField(error, 'code')).toBe('X_AI_PROVIDER_UNAVAILABLE');
    }
  });

  test('the phrase on a 5xx is an outage, not an overflow', async () => {
    for (const run of everyPath(503, ANTHROPIC)) {
      expect(await failureOf(run)).toBeInstanceOf(AiTransportError);
    }
  });
});

describe('nothing retries an overflow', () => {
  const overflowing = (name: string, calls: { n: number }): Provider => {
    const inner = anthropicProvider({
      models: FIXTURE_ANTHROPIC_IDS,
      apiKey: KEY,
      fetch: answering(400, ANTHROPIC),
    });
    return {
      name,
      models: FIXTURE_ANTHROPIC_IDS,
      generate: (request) => {
        calls.n += 1;
        return inner.generate(request);
      },
      stream: (request) => inner.stream(request),
    };
  };

  test('the gateway sends it once, to one provider, and rethrows it as itself', async () => {
    const first = { n: 0 };
    const second = { n: 0 };
    const gateway = providerGateway({
      providers: [overflowing('a', first), overflowing('b', second)],
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });
    const error = await failureOf(() =>
      gateway.generate({
        model: FIXTURE_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      }),
    );
    expect(stringField(error, 'code')).toBe('X_AI_CONTEXT_OVERFLOW');
    expect([first.n, second.n]).toEqual([1, 0]);
  });

  test('llm() raises it as itself, after one call', async () => {
    const calls = { n: 0 };
    configureAi({
      gateway: providerGateway({
        providers: [overflowing('a', calls)],
        defaultModel: FIXTURE_MODEL,
        sleep: () => Promise.resolve(),
      }),
    });
    const summarize = declare(promptFor());
    const error = await failureOf(() => summarize({ postId: POST_ID }, { ctx: anonymousCtx() }));
    expect(stringField(error, 'code')).toBe('X_AI_CONTEXT_OVERFLOW');
    expect(calls.n).toBe(1);
  });
});
