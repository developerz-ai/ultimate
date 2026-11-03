// The gateway's per-provider breaker: a provider down for good cost `attempts` calls plus backoff on
// EVERY call (20 calls, 3 attempts: 60 calls and 40 sleeps). Behind its breaker it costs
// `attempts × failures` and then nothing, while the next provider serves throughout.

import { describe, expect, test } from 'bun:test';
import { breaker, UltimateError } from '@ultimat3/core';
import { echoProvider } from './echo-provider';
import { AiTransportError } from './errors';
import { providerGateway } from './gateway';
import { attemptProviders } from './gateway-providers';
import { FIXTURE_ANTHROPIC_IDS, FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { GenerateResult, Provider, StreamChunk } from './provider';

useFixtureModels();

const REQUEST = { messages: [{ role: 'user' as const, content: 'x' }], maxTokens: 8 };

function failing(status: number): Provider & { calls: () => number } {
  let calls = 0;
  return {
    name: 'failing',
    models: FIXTURE_ANTHROPIC_IDS,
    calls: () => calls,
    generate(): Promise<GenerateResult> {
      calls += 1;
      return Promise.reject(new AiTransportError({ provider: 'failing', status, detail: 'no' }));
    },
    // biome-ignore lint/correctness/useYield: the failure happens before the first chunk
    async *stream(): AsyncIterable<StreamChunk> {
      calls += 1;
      throw new AiTransportError({ provider: 'failing', status, detail: 'no' });
    },
  };
}

function gatewayOver(first: Provider, breaker?: 'off') {
  const waits: number[] = [];
  const gateway = providerGateway({
    defaultModel: FIXTURE_MODEL,
    providers: [first, echoProvider()],
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...(breaker === undefined ? {} : { breaker }),
  });
  return { gateway, waits };
}

describe('unit · gateway · provider breaker', () => {
  test('20 calls to a down provider cost 15 of its calls; the second provider serves all 20', async () => {
    const down = failing(503);
    const { gateway, waits } = gatewayOver(down);
    const served: (string | undefined)[] = [];
    for (let n = 0; n < 20; n += 1) served.push((await gateway.generate(REQUEST)).provider);
    expect(down.calls()).toBe(15);
    // Two waits per pass for the first five passes, none once the breaker is open.
    expect(waits).toHaveLength(10);
    expect(new Set(served)).toEqual(new Set(['echo']));
  });

  test("breaker: 'off' is today's cost: every call re-spends the attempts", async () => {
    const down = failing(503);
    const { gateway } = gatewayOver(down, 'off');
    for (let n = 0; n < 20; n += 1) await gateway.generate(REQUEST);
    expect(down.calls()).toBe(60);
  });

  test('a 400 is the provider answering: it never opens the breaker', async () => {
    const refusing = failing(400);
    const { gateway } = gatewayOver(refusing);
    for (let n = 0; n < 10; n += 1) await gateway.generate(REQUEST);
    expect(refusing.calls()).toBe(10);
  });

  test('a stream skips a provider whose breaker is open', async () => {
    const down = failing(503);
    const { gateway } = gatewayOver(down);
    for (let n = 0; n < 5; n += 1) await gateway.generate(REQUEST);
    const before = down.calls();
    const chunks: StreamChunk[] = [];
    for await (const chunk of gateway.stream(REQUEST)) chunks.push(chunk);
    expect(down.calls()).toBe(before);
    expect(chunks.at(-1)?.type).toBe('done');
  });
});

describe('unit · gateway · breaker tickets', () => {
  function fakeClock(): { monotonic: () => number; advance: (ms: number) => void } {
    let at = 0;
    return {
      monotonic: () => at,
      advance: (ms) => {
        at += ms;
      },
    };
  }

  test("a caller's abort during the half-open probe gives it back and closes nothing", async () => {
    const clock = fakeClock();
    const gate = breaker({ name: 'p', failures: 1, cooldownMs: 1_000, clock });
    gate.failed(gate.admit());
    clock.advance(1_000);
    const aborting: Provider = {
      ...failing(503),
      generate: () =>
        Promise.reject(new UltimateError({ code: 'X_ABORTED', cause: 'gone', fix: 'retry' })),
    };
    await attemptProviders({
      model: FIXTURE_MODEL,
      candidates: [aborting],
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => undefined,
      random: undefined,
      gateOf: () => gate,
      call: (provider) => provider.generate(REQUEST),
    }).catch(() => undefined);
    expect(gate.state()).toBe('half-open');
    expect(gate.admit()?.probe).toBe(true);
  });

  test('a stream refused by the budget gives the half-open probe back', async () => {
    const clock = fakeClock();
    const gate = breaker({ name: 'p', failures: 1, cooldownMs: 1_000, clock });
    gate.failed(gate.admit());
    clock.advance(1_000);
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [echoProvider()],
      budget: { request: 1 },
      breaker: () => gate,
    });
    const refused = async (): Promise<void> => {
      for await (const _chunk of gateway.stream(REQUEST)) {
        // never reached: the reservation refuses before the provider is asked
      }
    };
    await expect(refused()).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(gate.admit()?.probe).toBe(true);
  });
});
