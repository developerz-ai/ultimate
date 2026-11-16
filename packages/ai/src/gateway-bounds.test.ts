// The gateway's own bounds and its model fallback: a bound screened where it is declared, and a
// refused model handing the call to the next one. Split from gateway.test.ts (routing, refusals).

import { describe, expect, test } from 'bun:test';
import { asyncRefusal, NOT_A_BOUND, refusal } from './bounds-fixture';
import { memoryBudgetStore } from './budget';
import { echoProvider } from './echo-provider';
import { AiTransportError } from './errors';
import { providerGateway } from './gateway';
import { FIXTURE_ANTHROPIC_IDS, FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { GenerateResult, Provider } from './provider';
import { totalTokens } from './provider';
import { runMeter } from './run-meter';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

const echo = echoProvider();

/**
 * The gateway's own two bounds, and neither had anything checking it.
 *
 * `retry.attempts` is the retry loop's only exit condition: `attempt <= NaN` is false on the first
 * comparison, so `attempt()` calls NO provider and raises `X_AI_PROVIDER_UNAVAILABLE` carrying an
 * EMPTY attempt list — measured, `no provider could serve model "claude-opus-5" ()` about a
 * provider that was never asked. `maxTokens` is screened here because this is the one seam every
 * model call in an app passes through, and because of where it goes next: it IS the pre-flight
 * estimate, and a `NaN` estimate passes every ceiling and then writes itself onto the ledger and
 * the per-process `BudgetStore`, turning the budget off for the life of the process.
 */
describe('the gateway screens its own bounds', () => {
  const counting = (): { provider: Provider; calls: () => number } => {
    let calls = 0;
    const provider: Provider = {
      name: 'counting',
      models: FIXTURE_ANTHROPIC_IDS,
      generate(request): Promise<GenerateResult> {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };
    return { provider, calls: () => calls };
  };

  test('retry.attempts is refused when the gateway is built, not on the first failure', () => {
    for (const attempts of [...NOT_A_BOUND, 0]) {
      const error = refusal(() =>
        providerGateway({
          defaultModel: FIXTURE_MODEL,
          providers: [echo],
          retry: { attempts, base: 0, max: 0, jitter: 'none' },
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('retry.attempts');
      expect(error.fix).toContain('gateway');
    }
  });

  test('a completion ceiling that is not a count never reaches a provider', async () => {
    const { provider, calls } = counting();
    const gateway = providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] });
    for (const maxTokens of [...NOT_A_BOUND, 0]) {
      const error = await asyncRefusal(() =>
        gateway.generate({ messages: [{ role: 'user', content: 'ping' }], maxTokens }),
      );
      expect(error.cause).toContain('maxTokens');
    }
    // The streamed half is the same request shape and the same screen.
    const stream = gateway.stream({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: Number.NaN,
    });
    const drain = await asyncRefusal(async () => {
      for await (const chunk of stream) void chunk;
    });
    expect(drain.cause).toContain('maxTokens');
    expect(calls()).toBe(0);
  });

  test('an honest gateway still answers — the non-vacuity half', async () => {
    const { provider, calls } = counting();
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [provider],
      retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
    });
    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
    });
    expect(result.text).toBe('ping');
    expect(calls()).toBe(1);
  });
});

// `fallbackModels`: the next model is asked only on a DECLARED class (`MODEL_FALLBACK_ON`), each
// attempt is reserved and settled on its own, and the run meter counts every attempt.
describe('model fallback', () => {
  const PRIMARY = 'claude-opus-5';
  const SECOND = 'claude-sonnet-5';
  const failing = (status: number, calls: string[]): Provider => ({
    name: 'primary-host',
    models: [PRIMARY],
    generate: async (request) => {
      calls.push(String(request.model));
      throw new AiTransportError({ provider: 'primary-host', status, detail: 'down' });
    },
    stream: (request) => echo.stream(request),
  });
  const serving = (calls: string[]): Provider => ({
    name: 'second-host',
    models: [SECOND],
    generate: (request) => {
      calls.push(String(request.model));
      return echo.generate(request);
    },
    stream: (request) => echo.stream(request),
  });
  const ask = {
    model: PRIMARY,
    messages: [{ role: 'user' as const, content: 'ping' }],
    maxTokens: 16,
  };

  test('fallback: the second model answers after the first fails overloaded, and both are counted', async () => {
    const calls: string[] = [];
    const store = memoryBudgetStore();
    const gateway = providerGateway({
      providers: [failing(529, calls), serving(calls)],
      retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
      budget: { actor: 10_000 },
      budgetStore: store,
    });
    const meter = runMeter();
    const result = await gateway.scope({ actorKey: 'actor:u1' }, () =>
      meter.call(() => gateway.generate({ ...ask, fallbackModels: [SECOND] })),
    );

    expect(calls).toEqual([PRIMARY, SECOND]);
    expect(result.model).toBe(SECOND);
    expect(result.provider).toBe('second-host');
    expect(result.fallbacks?.map((f) => [f.model, f.reason])).toEqual([[PRIMARY, 'overloaded']]);
    // The meter: the answer priced, the failed attempt counted — never silently free.
    expect(meter.billed()).toMatchObject({ calls: 1, unsettled: 1, cost: result.costExact });
    // The ledger: the first reservation given back, the second booked at what it cost.
    expect(store.spent('actor:u1')).toBe(totalTokens(result.usage));
  });

  test('fallback: a 400 is the request, not the model — the chain stops there', async () => {
    const calls: string[] = [];
    const gateway = providerGateway({
      providers: [failing(400, calls), serving(calls)],
      retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
    });
    await expect(gateway.generate({ ...ask, fallbackModels: [SECOND] })).rejects.toMatchObject({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
    });
    expect(calls).toEqual([PRIMARY]);
  });

  test('fallback: a coded refusal (the budget) is never fallen over', async () => {
    const calls: string[] = [];
    const gateway = providerGateway({
      providers: [failing(529, calls), serving(calls)],
      budget: { request: 1 },
    });
    await expect(
      gateway.scope({}, () => gateway.generate({ ...ask, fallbackModels: [SECOND] })),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(calls).toEqual([]);
  });
});
