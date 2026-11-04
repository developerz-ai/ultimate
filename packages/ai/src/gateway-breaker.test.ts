// The gateway's per-provider breaker: a provider down for good cost `attempts` calls plus backoff on
// EVERY call (20 calls, 3 attempts: 60 calls and 40 sleeps). Behind its breaker it costs
// `attempts × failures` and then nothing, while the next provider serves throughout.
//
// The contract is ONE breaker per provider, and the STREAM path asks for a provider's breaker
// TWICE — once inside `admittedProvider` to take the admission ticket, once after it to settle
// that ticket — so with an app's own `breaker: (provider) => breaker({ … })` factory the two asks
// could answer with two DIFFERENT breakers. The ticket was then issued by one breaker and settled
// by another, and a half-open probe held by the first was never closed nor given back by it: the
// next call waited out a whole extra cooldown for a probe that had already answered. The factory
// is now asked once per provider and its answer kept (`providerBreakers`); the two tests at the
// end pin that.
//
// This file was NOT the subject of CI run 41714452760's red `unit-3` part. That part's failure
// was a TIMEOUT in `packages/testing/src/isolated-plugins.test.ts` — a whole-tree scan whose cost
// grows with every package the tree gains — and this file is not in the `unit-3` shard anyway.
// The run's job log is not reachable from this checkout and no artifact of it exists in the tree,
// so the failing test's own name rests on that measurement, not on a log.
//
// What IS re-derivable is this FILE's shard membership: the repo's own algorithm
// (`packages/cli/src/verify-shard.ts`, the pure round-robin CI uses — `ci.yml` passes no
// `--timings`) over the gate's own discovery (`discoverTests(root, undefined, 'unit')`) puts THIS
// file in shard 3 of 3. An index is a snapshot of a corpus every added test file shifts, so the
// shard — re-derivable from the algorithm above — is the claim that carries.

import { describe, expect, test } from 'bun:test';
import type { Breaker } from '@ultimat3/core';
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

/**
 * The STREAM path asks for a provider's breaker twice: `admittedProvider` takes the admission
 * ticket, and the caller settles that ticket. Both asks must answer with the SAME breaker — the
 * documented contract is ONE breaker per provider — or the ticket is settled by a breaker that
 * never issued it, and the half-open probe it came from is never given back.
 */
describe('unit · gateway · one breaker per provider', () => {
  function fakeClock(): { monotonic: () => number; advance: (ms: number) => void } {
    let at = 0;
    return {
      monotonic: () => at,
      advance: (ms) => {
        at += ms;
      },
    };
  }

  test("an app's breaker factory is asked once per provider, not once per ask", async () => {
    const clock = fakeClock();
    const made: Breaker[] = [];
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [echoProvider()],
      breaker: () => {
        const gate = breaker({ name: 'p', failures: 1, cooldownMs: 1_000, clock });
        made.push(gate);
        return gate;
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of gateway.stream(REQUEST)) chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe('done');
    // The stream path asks TWICE (admit, then settle). One breaker per provider means the
    // factory answered once and the second ask found the first answer.
    expect(made).toHaveLength(1);
  });

  test("a provider's stream failures accumulate on ONE breaker, so it opens", async () => {
    const clock = fakeClock();
    const made: Breaker[] = [];
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [failing(503)],
      breaker: () => {
        const gate = breaker({ name: 'p', failures: 3, cooldownMs: 1_000, clock });
        made.push(gate);
        return gate;
      },
    });
    const failed = async (): Promise<void> => {
      for await (const _chunk of gateway.stream(REQUEST)) {
        // never reached: the provider throws before its first chunk
      }
    };
    for (let n = 0; n < 3; n += 1) await failed().catch(() => undefined);

    // ONE breaker per provider: the three failures counted on it, and it is OPEN. Split across
    // throwaway breakers the count never reached the limit, so a provider down for good was
    // asked again on every call, forever — the breaker never skipped it once.
    expect(made).toHaveLength(1);
    const gate = made[0];
    expect(gate).toBeDefined();
    if (gate === undefined) expect.unreachable('the gateway never asked for its breaker');
    expect(gate.failures()).toBe(3);
    expect(gate.state()).toBe('open');
  });
});
