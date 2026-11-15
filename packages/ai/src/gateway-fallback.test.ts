// `fallbackModels` beyond the one-call case `gateway.test.ts` pins: the stream's first-chunk rule,
// the attempt spans under one parent, a whole chain failing, the chain's screen, and the class table.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import { breaker, resetTelemetry, subscribe, withSpan } from '@ultimat3/core';
import { echoProvider } from './echo-provider';
import { AiBudgetExceededError, AiTransportError } from './errors';
import { providerGateway } from './gateway';
import type { ModelFallbackClass } from './model-fallback';
import { fallbackClassOf, MODEL_FALLBACK_ON, transportFallbackClass } from './model-fallback';
import { useFixtureModels } from './model-fixture';
import type { GenerateRequest, Provider, StreamChunk } from './provider';
import { runMeter } from './run-meter';

useFixtureModels();

const PRIMARY = 'claude-opus-5';
const SECOND = 'claude-sonnet-5';
const echo = echoProvider();
const ask: GenerateRequest = {
  model: PRIMARY,
  fallbackModels: [SECOND],
  messages: [{ role: 'user', content: 'ping' }],
  maxTokens: 16,
};
const down = (status: number) =>
  new AiTransportError({ provider: 'primary-host', status, detail: 'down' });

/** A host for one model whose calls are logged; `fail` decides what each call does instead. */
function host(model: string, calls: string[], fail?: 'before' | 'after' | number): Provider {
  return {
    name: `${model}-host`,
    models: [model],
    generate: async (request) => {
      calls.push(model);
      if (typeof fail === 'number') throw down(fail);
      return echo.generate(request);
    },
    async *stream(request): AsyncIterable<StreamChunk> {
      calls.push(model);
      if (fail === 'before') throw down(503);
      for await (const chunk of echo.stream(request)) {
        yield chunk;
        if (fail === 'after') throw down(503);
      }
    },
  };
}

const gatewayOf = (...providers: Provider[]) =>
  providerGateway({
    providers,
    retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
    breaker: 'off',
  });

const drain = async (stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('a streamed fallback', () => {
  test('falls over when the first model fails before its first chunk, and says so on done', async () => {
    const calls: string[] = [];
    const chunks = await drain(
      gatewayOf(host(PRIMARY, calls, 'before'), host(SECOND, calls)).stream(ask),
    );
    expect(calls).toEqual([PRIMARY, SECOND]);
    const done = chunks.at(-1);
    expect(done?.type === 'done' && done.result.model).toBe(SECOND);
    expect(done?.type === 'done' && done.result.fallbacks?.map((f) => f.reason)).toEqual([
      'unavailable',
    ]);
  });

  test('never falls over once a chunk reached the consumer', async () => {
    const calls: string[] = [];
    const gateway = gatewayOf(host(PRIMARY, calls, 'after'), host(SECOND, calls));
    await expect(drain(gateway.stream(ask))).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([PRIMARY]);
  });

  test('a non-declared failure before the first chunk does not fall over either', async () => {
    const calls: string[] = [];
    const refusing: Provider = {
      ...host(PRIMARY, calls),
      // biome-ignore lint/correctness/useYield: the failure happens before the first chunk
      async *stream(): AsyncIterable<StreamChunk> {
        calls.push(PRIMARY);
        throw down(400);
      },
    };
    await expect(drain(gatewayOf(refusing, host(SECOND, calls)).stream(ask))).rejects.toMatchObject(
      { status: 400 },
    );
    expect(calls).toEqual([PRIMARY]);
  });
});

describe('one trace', () => {
  let spans: ReadableSpan[] = [];
  beforeEach(() => {
    resetTelemetry();
    spans = [];
    subscribe('span.end', (event) => spans.push(event.payload));
  });

  test('one parent span, one ai.model.attempt child per model, the failed one naming its class', async () => {
    const calls: string[] = [];
    const gateway = gatewayOf(host(PRIMARY, calls, 429), host(SECOND, calls));
    await withSpan('caller', () => gateway.generate(ask));

    const parent = spans.find((span) => span.name === 'caller');
    const attempts = spans.filter((span) => span.name === 'ai.model.attempt');
    expect(attempts.map((span) => span.attributes['gen_ai.request.model'])).toEqual([
      PRIMARY,
      SECOND,
    ]);
    expect(parent?.context.spanId).toBeString();
    expect(attempts.every((span) => span.parentSpanId === parent?.context.spanId)).toBe(true);
    expect(attempts[0]?.attributes['ultimate.llm.fallback.reason']).toBe('rate_limited');
  });

  test('a call with no fallbackModels opens no attempt span — its trace is what it was', async () => {
    await gatewayOf(echo).generate({ model: PRIMARY, messages: ask.messages, maxTokens: 16 });
    expect(spans.filter((span) => span.name === 'ai.model.attempt')).toEqual([]);
  });
});

describe('a whole chain failing', () => {
  test('throws one coded error naming every model, and the meter counts each attempt', async () => {
    const calls: string[] = [];
    const gateway = gatewayOf(host(PRIMARY, calls, 503), host(SECOND, calls, 529));
    const meter = runMeter();
    const failure = await meter.call(gateway.generate(ask)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
    expect(String((failure as { cause?: unknown }).cause)).toContain(`${PRIMARY} → ${SECOND}`);
    expect(meter.billed()).toMatchObject({ calls: 0, unsettled: 2 });
  });
});

describe('the chain is screened before any call', () => {
  test('an unregistered fallback model is X_AI_MODEL_UNKNOWN, nothing sent', async () => {
    const calls: string[] = [];
    const gateway = gatewayOf(host(PRIMARY, calls, 503));
    await expect(gateway.generate({ ...ask, fallbackModels: ['nope-1'] })).rejects.toMatchObject({
      code: 'X_AI_MODEL_UNKNOWN',
    });
    expect(calls).toEqual([]);
  });

  test('a model named twice is X_AI_REQUEST_INVALID, nothing sent', async () => {
    const calls: string[] = [];
    const gateway = gatewayOf(host(PRIMARY, calls, 503), host(SECOND, calls));
    await expect(
      gateway.generate({ ...ask, fallbackModels: [SECOND, PRIMARY] }),
    ).rejects.toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(calls).toEqual([]);
  });
});

describe('the declared classes', () => {
  test('each status and socket code maps to its class; a 4xx and a stray throw to none', () => {
    expect(MODEL_FALLBACK_ON).toEqual(['rate_limited', 'overloaded', 'timeout', 'unavailable']);
    const cases: ReadonlyArray<readonly [unknown, ModelFallbackClass | undefined]> = [
      [{ status: 429 }, 'rate_limited'],
      [{ status: 529 }, 'overloaded'],
      [{ status: 408 }, 'timeout'],
      [{ status: 504 }, 'timeout'],
      [{ code: 'ETIMEDOUT' }, 'timeout'],
      [{ status: 500 }, 'unavailable'],
      [{ code: 'ConnectionRefused' }, 'unavailable'],
      [{ status: 400 }, undefined],
      [{ status: 409 }, undefined],
      [{ status: 401 }, undefined],
      [new TypeError('bug'), undefined],
      ['503', undefined],
    ];
    for (const [error, reason] of cases) expect(transportFallbackClass(error)).toBe(reason);
  });

  test('a coded refusal never falls over, even one carrying a transient-looking status', () => {
    const budget = new AiBudgetExceededError({
      scope: 'org',
      requested: 2,
      remaining: 1,
      limit: 1,
    });
    expect(fallbackClassOf(Object.assign(budget, { status: 503 }))).toBeUndefined();
    expect(fallbackClassOf(down(503))).toBe('unavailable');
  });

  test("an open breaker on the first model's only host falls over as unavailable", async () => {
    const calls: string[] = [];
    const open = breaker({ name: 'primary', failures: 1, cooldownMs: 60_000 });
    open.failed(open.admit());
    const closed = breaker({ name: 'second', failures: 5, cooldownMs: 60_000 });
    const gateway = providerGateway({
      providers: [host(PRIMARY, calls), host(SECOND, calls)],
      retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
      breaker: (provider) => (provider.models.includes(PRIMARY) ? open : closed),
    });
    const result = await gateway.generate(ask);
    expect(calls).toEqual([SECOND]);
    expect(result.fallbacks?.map((f) => [f.model, f.reason])).toEqual([[PRIMARY, 'unavailable']]);
  });
});
